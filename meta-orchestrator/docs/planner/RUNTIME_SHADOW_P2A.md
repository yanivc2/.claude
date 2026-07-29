# P2a — Runtime integration in shadow mode

**The Planner is connected, and it changes nothing.** P2a wires the Pre-execution Cost
Planner into the orchestrator as a pure *observer*: it sees the same pre-flight request
the circuit breaker is about to act on, produces its own estimate, cost projection and
governance preview, and records that observation off to the side. It never moves the
estimate the gate acts on, the model, the budget, the routing, or the user-visible
result.

This is the phase that answers one question with evidence instead of assertion: **does
the product estimator agree with the `chars // 4` heuristic the runtime actually uses?**
— without letting the answer touch a single run.

```
planner/integration/
  __init__.py        the only Planner surface the orchestrator may import
  case.py            ShadowCase — the four fields the adapter reads off a task
  errors.py          ShadowConfigError, ShadowFailureKind
  request_adapter.py BugCase -> content metrics -> stages -> plan snapshot -> request
  shadow_runner.py   estimate -> price -> governance preview -> divergence -> record
  result.py          PlannerShadowResult, DivergenceReport, ShadowFailure, sinks
```

---

## 1. Feature flags

Four flags on `OrchestratorConfig`, every one defaulting **off**:

```
planner_enabled             = false
planner_shadow_mode         = false
planner_enforcement_enabled = false
planner_real_spend_enabled  = false
```

P2a authorises exactly two, and only together:

```
planner_enabled     = true
planner_shadow_mode = true
```

`planner_enforcement_enabled` and `planner_real_spend_enabled` are **refused**. Switching
either on raises `ShadowConfigError` when the orchestrator constructs the shadow runner —
loudly, because that is a misconfiguration, not a runtime condition to observe. The
observer cannot be promoted into a decision-maker by a stray flag.

Only the two observer flags are readable from the environment (`META_ORCH_PLANNER_ENABLED`,
`META_ORCH_PLANNER_SHADOW`). There is deliberately no env var for enforcement or real
spend: turning those on takes a later phase and a code change, not a variable.

### When every flag is off

The orchestrator behaves exactly as it did before the Planner existed. It builds no
shadow runner and no sink (`shadow_runner is None`, `shadow_sink is None`), opens no
database, records nothing, and spends nothing extra. Tested directly: a run with the
flags off and a run with them on produce a byte-for-byte identical `RunOutcome`.

---

## 2. Where it hooks in, and why it is a side-channel

The shadow runs inside the orchestrator's `_gate` node — the circuit-breaker step — right
after the legacy pre-flight numbers are computed and **before** the affordability check:

```
est_in, est_out = self._estimate_io_tokens(case)     # legacy chars // 4
est_tokens      = est_in + est_out
est_cost        = self._worst_case_cost(est_in, est_out)
self._run_shadow(state, est_tokens=est_tokens, est_cost=est_cost)   # observe only
if not ledger.can_afford(est_tokens): ...            # unchanged legacy decision
```

`_run_shadow` returns nothing the gate uses. The shadow observation goes to a **separate
sink** (`orchestrator.shadow_sink`), never into the run state or the `RunOutcome`. That is
the whole design: because the result is off to the side, the run's decision, routing,
tokens, cost, and trace are identical whether the shadow ran or not — the "output
unchanged with shadow enabled" property is structural, not a thing we hope holds.

Two separations are kept explicit, per the phase brief:

```
legacy_runtime_decision       — what the circuit breaker actually does (unchanged)
planner_shadow_recommendation — what the Planner would have said (recorded, never acted on)
```

When they differ, the divergence is recorded. Nothing is auto-selected, no model changes,
no budget moves, no approval opens.

---

## 3. The adapter (§9 scope)

`request_adapter.py` turns the task the orchestrator is about to run into something the
estimator understands, and models **only** the seed task the engine really runs:

- `generate` — shown both sources (module + tests), writes the repaired module, with a
  bounded retry allowance equal to `max_rounds - 1`. Unbounded retries are refused; an
  unbounded worst case is not a worst case.
- `synthesize` — the single coherent-output pass over the produced candidate.

The independent verifier is a *tool* (test) call, not a paid model call, so it contributes
no model tokens and is not modelled as one. No stages are invented for research, images,
documents, or workflows the engine has no path for.

The adapter reads nothing — no file, no network, no clock. The orchestrator already holds
the sources in memory; the adapter only measures them (code points, bytes, script, family).
That is what keeps the estimate free of side effects.

---

## 4. Legacy vs Planner — the divergence artifact

Every shadow run produces a `PlannerShadowResult` carrying a `DivergenceReport`:

```
legacy_tokens                      the chars // 4 number the circuit breaker uses
planner_tokens_best/expected/worst the product estimate's band (model-independent)
legacy_tokens_in_planner_range     is the runtime's number even plausible?
token_divergence_abs / _pct        expected − legacy, and the fraction (None if legacy = 0)
legacy_cost / planner_cost_*        the worst-case cost envelope across candidates
legacy_cost_in_planner_range       same question, for money
cost_divergence_abs / _pct
```

The cost side is anchored to the **worst-case candidate** (the dearest by worst cost),
the same fail-safe basis the legacy circuit breaker uses when it takes the max across
candidates. There is no single "selected model" here: selection happens *after* the gate,
so `selected_model` is `None` by construction and `worst_case_model_id` names the anchor.

Observed on the seed case today: the runtime's `chars // 4` estimate lands **outside** the
Planner's plausible token range — the heuristic counts one body once, while the estimator
accounts for both sources, the bounded retries, and the synthesizer pass. This is exactly
the finding shadow mode exists to make visible, and it is now visible without acting on it.

**No learning.** The divergence is recorded, never fed back. No coefficient is updated, no
calibration runs. That is a later phase with its own gate.

---

## 5. G1 status after P2a

```
Legacy runtime estimator: still present and still used (chars // 4)
Planner estimator:        connected in shadow, produces legacy_estimate vs planner_estimate
Enforcement path:         still 100% legacy behaviour
Overall status:           SHADOW_FIXED, not ENFORCED
```

`chars // 4` is not deleted and not marked fixed. The Planner replaces it only for the
*shadow* computation; the runtime keeps using the legacy value for every decision. G1
becomes `FULLY_FIXED` only when the Planner becomes the authorised runtime path — a
future phase, not this one.

---

## 6. Price trust (§12): stated, never overstated

The result states the pricing authority plainly and never inflates it:

```
price_trust                    e.g. fictional (mock) / repository_verified (real)
authoritative_for_real_spend   true only for billable trust; mock prices are false
price_age_days / freshness_warning
per_candidate_costs[]          each candidate's band, trust, and price card id
```

- Mock models (`mock-strong`, `mock-weak`) carry **FICTIONAL** prices: the cost projects
  for observability but `authoritative_for_real_spend` is `false` and a warning says so.
- Real models (`claude-opus-4-8`, `claude-haiku-4-5`) carry **REPOSITORY_VERIFIED** prices:
  billable, but the governance preview still records `price_not_provider_verified` — traceable
  in-repo, never re-checked against the provider. No card is provider-verified today, and
  the artifact never claims otherwise.

A missing price for a model degrades that candidate to unavailable and the cost comparison
to "unavailable" — the **token** comparison still stands. Nothing about a missing price
changes execution.

---

## 7. Governance preview

The shadow runs a real `GovernedBudgetGuard.admit` under `purpose = SIMULATION` against the
worst-case candidate. It surfaces the conditions a real admission would carry — price
trust, freshness, reserve eligibility, estimator-is-heuristic — as acknowledgeable
warnings, and reports `would_admit_as_simulation`.

The orchestrator's real budget is **token-denominated**; there is no money cap in P2a. So
the preview is sized above the projection on purpose — a budget breach here would be
fabricated. The preview's value is the *conditions*, not an invented overspend. Every
artifact it touches is stamped `NOT_ELIGIBLE_FOR_REAL_SPEND`.

---

## 8. Persistence and spend (§10, §11)

- The default sink is **in memory** (`InMemoryShadowSink`). P2a opens no database on the
  runtime path. Rollback is trivial: drop the sink, and the observations are gone.
- **No reservation, no committed spend, no actual spend.** The shadow builds no
  `SpendReservation`, calls no `BudgetService`, and touches no `GovernanceStore`. Purpose
  is SIMULATION throughout.
- **No approval flow.** The shadow works only on information already present before the run;
  it makes no model call, no `count_tokens`, and no network request to produce an estimate.
  If shadow mode ever required a paid call to estimate, that would be forbidden — and it
  does not.

---

## 9. Error isolation (§14)

A Planner failure must never break the runtime it observes — and it must never be silent.

- The `ShadowRunner` catches every exception, classifies it (`ShadowFailureKind`:
  estimator-unavailable, pricing-unavailable, invalid-plan, governance-preview-unavailable,
  persistence-unavailable, unexpected-internal-error), and records a `ShadowFailure`. It
  returns `None`; it never raises to the orchestrator.
- The orchestrator's `_run_shadow` wraps the call in a second catch-all, so even a
  construction-time contract could not leak into execution.
- Failures are recorded to `shadow_sink.failures`, never swallowed. A shadow that stopped
  producing results is visible, and points at which Planner component is not ready.

Governance preview is best-effort: if it cannot run, the estimate and divergence still
stand and a warning is recorded — the whole observation is not lost for one optional part.

---

## 10. Latency (§15)

The runner measures its own local wall-clock cost per phase — adapter construction,
estimation, pricing, governance preview — into a `ShadowLatency` attached to each result.
No provider latency is measured; there is nothing remote on this path.

Latency is a measurement that varies between runs, so it is **excluded from the result's
content hash**: two runs of the same request produce the same hash. The stopwatch
(`timer`) is injectable, so tests are deterministic.

Measured overhead is small — single-digit milliseconds per run on the seed case (see the
stop block for the sampled median/max). There is no numeric budget enforced in P2a; the
number is reported so a later phase can set one.

---

## 11. Rollback (§19)

```
planner_enabled = false
```

With the flag off: no shadow runner is constructed, no sink exists, no observation is
recorded, and nothing about execution changes. The shadow database is disposable by
construction (there isn't one on the default path), so there is no migration to undo.

---

## 12. What is still not done

- **No enforcement.** The Planner cannot stop, reroute, or re-price a run. Refused at
  construction.
- **No real spend.** No reservation, no committed or actual spend. Refused at construction.
- **No PR, no merge to `main`.** P2a lives on the integration branch.
- **Main-side Next.js validation** (`next lint` / `next build`) remains a precondition for
  any merge to `main`; byte-for-byte preservation is not a build.
- **G1 is `SHADOW_FIXED`, not `ENFORCED`.**

The next phase (P2b) would be enforcement, and it needs its own explicit GO.

---

## 13. Tests

`tests/test_planner_integration.py` covers the phase contract: flags default off and off
builds nothing; a successful / aborted / blocked run is identical with the shadow on; the
shadow adds no tokens and no cost; enforcement and real spend are refused; divergence is
computed and reports whether the legacy value is in range; mock prices are non-authoritative
and real prices are billable-but-not-provider-verified; a model with no price degrades to a
tokens-only result; the governance preview runs as SIMULATION; Hebrew and source-code content
route to different rules; the retry allowance and candidate models pass through; a broken
estimator records a failure without raising, and a broken shadow does not break the run; the
result hash is deterministic and ignores latency; and the shadow creates no reservation and
opens no database.

The P1d guard `test_the_orchestrator_reaches_the_planner_only_through_the_integration_boundary`
now asserts the orchestrator references `planner.integration` and still none of
`planner.persistence`, `planner.governance`, `GovernanceStore`, or `BudgetService` directly.
