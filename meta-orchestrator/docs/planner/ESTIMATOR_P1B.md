# P1b — Rules-Based Usage Estimator

**Scope: `EstimationRequest -> UsageEstimate -> [PricingSource] -> CostProjection`.**

The estimator answers *how much usage will this plan take*. It does not price it, does
not decide whether a run may proceed, and does not read anything — it is handed
measured facts and returns token bands.

Location: `src/meta_orchestrator/planner/estimation/` (provisional, decision 11.1 open).

```
metrics.py          ContentMetrics, ContentFamily, ScriptHint, RequestOverheads
profiles.py         TokenRule, OutputProfile, RuleBasis, ruleset versions
request.py          EstimationRequest, StageInput, CallKind
entities.py         Band, CallGroupEstimate, StageUsageEstimate, Completeness, UsageEstimate
estimator.py        UsageEstimator — deterministic, offline, stateless
projection.py       EstimateProjector -> CostProjection (through the pricing surface)
time_estimation.py  TimeEstimatorPort + an explicit refusal as the default
errors.py           fail-closed errors
```

---

## 1. What it estimates, and what it refuses to

| Estimates | Does not estimate |
|---|---|
| input tokens per stage, per call kind | how long anything takes (see §8) |
| output tokens from an explicit profile | a calibrated confidence (see §5) |
| model calls, retries, verification, rework | which model to use — no routing |
| human minutes the plan declared | whether a plan may execute |
| cost, via the P1a pricing port | prices — those come from P1a |

---

## 2. No single characters-per-token multiplier

The orchestrator's `chars // 4` is the local instance of a general mistake: the ratio
differs by roughly a factor of four across the content this system handles. Each
content family gets its own rule, in **code points per token** — lower means denser.

| Family | sparse | expected | dense | Why |
|---|---|---|---|---|
| `PROSE_LATIN` | 4.5 | 4.0 | 3.2 | English sits near 4 chars/token on BPE vocabularies trained mostly on English |
| `PROSE_HEBREW` | 2.2 | **1.7** | 1.1 | a smaller share of tokenizer training data, so words fragment more; two UTF-8 bytes per character |
| `PROSE_MIXED` | 3.0 | 2.2 | 1.3 | bounded below by its densest component; script switches break tokens |
| `SOURCE_CODE` | 4.0 | 3.3 | 2.4 | punctuation, indentation and identifier fragments each tokenize separately |
| `STRUCTURED_DATA` | 3.5 | 2.8 | 2.0 | heavy punctuation and repeated keys |
| `DIFF_PATCH` | 3.8 | 3.0 | 2.2 | code plus line markers and hunk headers |
| `TOOL_SCHEMA` | 3.2 | 2.6 | 1.9 | JSON with long descriptions and deep nesting |
| `UNKNOWN` | 3.0 | 2.0 | **1.0** | deliberately pessimistic — one token per character at worst |

**Hebrew** is the case that motivates the whole design. At the Latin ratio a Hebrew
prompt would be understated roughly two-fold. `test_hebrew_is_priced_denser_than_english`
asserts the gap is a factor, not a rounding difference.

**Unknown** content is priced at the pessimistic bound and marks the estimate *partial*.
Guessing a friendlier ratio for text nobody classified is how an estimate silently
understates.

Two size measures are kept apart: UTF-8 bytes (what crosses the wire — Hebrew costs
two per character) and Unicode code points (what a reader calls "characters").
Neither is tokens; both are inputs to a rule. Conversion always rounds **up**, because
a partial token is still billed.

---

## 3. Every coefficient is a heuristic, and says so

`RuleBasis` is `HEURISTIC`, `HISTORICAL_AVERAGE`, `CALIBRATED` or `LEARNED`. **Only
`HEURISTIC` is permitted in P1b**, enforced by a validator — constructing a rule with
any other basis raises.

Nothing in this repository has ever compared an estimated token count with an actual
one, so no stronger label would be truthful. The §2 closeout is the standing reason:
its headline result was apparatus-dominated and its confidence rested on n=8. The
lesson carried forward is not "avoid estimates" but "never let one claim a provenance
it does not have".

Every rule carries a `rationale` and its `limitations`, and both travel into the
result.

---

## 4. Output is not a function of input size

A short question about a large repository does not produce a long answer. Output comes
from an explicit `OutputProfile` and an explicit cap, never from the prompt size.

| Profile | best | expected | worst |
|---|---|---|---|
| `none` | 0 | 0 | 0 |
| `default_short` | 64 | 256 | 1024 |
| `structured_json` | 64 | 512 | 2048 |
| `code_patch` | 128 | 800 | 4096 |
| `analysis` | 256 | 1200 | 4096 |
| `document` | 512 | 2048 | 8192 |

Output scales with `artifact_count` — three files means three times the output — not
with input length. `test_output_does_not_grow_with_input_size` multiplies the input a
thousand-fold and asserts the output band is unchanged.

An explicit `output_cap_tokens` clamps every bound; a cap above the profile does not
inflate it. The cap is **per call**, so a stage making four calls in its worst case is
bounded by `4 × cap`.

---

## 5. Confidence is `UNKNOWN`; completeness is a different thing

`UsageEstimate` has a validator that **rejects any confidence other than `UNKNOWN`**.
Not a convention — a constructor error.

`Completeness` is a separate measure: how many stages were fully specified, how many
content bodies were unclassified, what inputs are missing. It answers *how much did we
know*, not *will the range contain the truth*. It deliberately exposes no probability
and no method named for one, and the two are never combined into a single score.

A missing input produces a blocking `ClarifyingQuestion` and marks the estimate
partial. It does not produce a number with a caveat attached.

---

## 6. Retries and verification are visible line items

Each stage decomposes into `CallGroupEstimate` entries by `CallKind`: `PRIMARY`,
`RETRY`, `VERIFIER`, `REPAIR`, `SYNTHESIS`, `USER_CLARIFICATION`. `tokens_by_call_kind()`
shows where the tokens went, so a total can always be decomposed.

- **Retries** — best assumes none fire, worst assumes the whole allowance does,
  expected takes half rounded down. That halving is a stated heuristic, not a
  measurement, and it is recorded in the stage's assumptions.
- **Verification** rounds are planned, so they occur in every case.
- **Rework** is conditional on a verification failing, so its best case is zero.

**Unbounded retries fail closed.** `max_retries=None` raises `UnboundedEstimateError`.
An invented finite bound is the most dangerous kind of wrong: it looks like a limit.

---

## 7. Execution modes

The estimator evaluates a plan it is given; it never invents one and never routes.

- **`AUTOMATIC`** — every model stage, verifier, retry and rework the plan declares.
- **`HUMAN_ASSISTED`** — a human stage costs no model tokens **only when the plan says
  so explicitly**. `human_output_needs_review=True` means the review pass is counted,
  and a human stage that makes model calls without a declared review step is rejected
  at construction. Human assistance is not assumed to be cheaper; `human_minutes`
  never disappears from the result.
- **`LOW_COST`** — a genuinely different plan (fewer retries, fewer verifier rounds, a
  shorter output profile, a tighter cap), not a discount applied to the same one. The
  `ExecutionPlan` contract already refuses a `LOW_COST` plan that does not state what
  it gave up.

---

## 8. Time: an explicit refusal

`UnavailableTimeEstimator` returns `available=False` with a reason. There is no
latency data here — `ModelSpec.latency_ms` holds four seeded numbers that were never
measured, and live lookups are out of scope. A duration derived from them would be a
guess wearing the costume of a measurement.

What it *does* return is the part that can be derived honestly: parallel groups from
the declared dependencies, the structural critical path, and the human minutes the
plan itself stated. The contract, the port and the separation of time kinds (compute /
provider wait / verification / human / externally blocked) are all in place, so a
later phase can supply a real profile without reshaping anything.

---

## 9. Cost projection

`EstimateProjector` is the only place estimation and pricing meet, and it goes through
the public pricing surface.

- Three whole quotes per model — best, expected, worst — each on that model's own card.
  **Never a blend**: the G2 rule holds here as in the calculator.
- **A missing price does not destroy the token estimate.** The projection reports
  itself unavailable with a reason; the `UsageEstimate` is untouched. A token count is
  useful on its own.
- A `FICTIONAL` or `TEST_ONLY` price still projects — tests need it — but arrives with
  `authoritative_for_real_spend = False`. `CostProjection.billable` filters to real
  prices only.
- Cache tokens are projected as zero and the caching expectation is surfaced as a
  warning, since no cache rate is known for any model.

---

## 10. Fail-closed, with no fallbacks

There is no path back to a silent default. Each of these raises: an unknown content
family, an unknown output profile, unbounded retries, a band that violates
`best ≤ expected ≤ worst`, a human stage making unreviewed model calls, human minutes
on a model stage. A static test asserts no module contains a `// 4` shortcut.

---

## 11. Determinism and audit

Every estimate records `estimator_id`, `estimator_version`, `ruleset_version`, the full
64-hex `request_hash`, the plan id, version and hash, the rule families used, the
output profile, the assumptions and the missing inputs. `canonical_json()` is stable
and `audit_hash()` is a full SHA-256; the short form is display only.

The same request always produces the same estimate. Totals are **derived** from stage
estimates rather than stored beside them, so they cannot drift.

---

## 12. G1 status

```
Runtime status:      still active in the Orchestrator (chars // 4)
Product replacement: implemented and tested
Integration status:  not connected
Overall status:      REPLACEMENT_READY, not FIXED
```

The orchestrator is untouched. It still runs its own pre-flight estimate, now with the
G2 arithmetic fix from `8f3ad61`. A test asserts the orchestrator source contains no
reference to `planner.estimation` — the boundary is checked, not assumed.

Wiring is a separate, explicitly authorised integration step after P1c.

---

## 13. Future calibration — what would have to be true

Not implemented, and gated on evidence rather than on a schedule:

1. Actuals collected per stage with the seven §2 observability fields.
2. `EstimateVariance` records classified by source; apparatus failures excluded by
   construction (`is_usable_for_calibration()` already enforces this).
3. Enough usable observations **within a single task family** before any coefficient
   moves — a rule fitted across families would learn the mix, not the task.
4. Coefficients versioned and reversible; a proposal is reviewed, never self-applied.
5. Only then may a rule's basis advance beyond `HEURISTIC`, and only then may
   confidence stop being `UNKNOWN` — and it must be justified by coverage, i.e. does
   the stated 80% range actually contain 80% of outcomes.

`ALLOWED_BASES_P1B` and the confidence validator are the two locks that make step 5
impossible to reach by accident.

---

## 14. Conditions for moving to P1c

- Contracts, pricing and estimation each independently tested and green.
- `BudgetGuard` can consume a `CostProjection` and refuse a non-authoritative price —
  the flag it needs already exists.
- `ApprovalGate` can bind a decision to a plan hash and an estimator reference — both
  already recorded.
- Reserve / contingency to be designed as an **explicit separate component**, never
  folded into a token rate. That was the G2 mistake and it is not coming back.

---

## 15. Open

- Package location (decision 11.1) — still provisional.
- `ModelSpec` float fields — reduced, not closed. See `PRICING_P1A.md` §5.
- Cache rates — `UNKNOWN` for every model until a citable source exists.
- Time estimation — deliberately unavailable.
- Every coefficient in §2 and §4 — heuristic, unmeasured, and labelled as such.
