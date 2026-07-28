# Pre-execution Project Cost Planner — P0 Architecture Note

**Status: P0 (contracts only).** Nothing described here estimates, prices, approves,
spends or executes. This note records the boundaries, the invariants the contracts
enforce, the four decisions deliberately left open, and the recommendation for each.

Scope of this document: `src/meta_orchestrator/planner/contracts/` and
`tests/test_planner_contracts.py`.

---

## 1. What the Planner is, and what it is not

The Planner sits **before** the execution engine. It takes a characterised request,
breaks it into stages, estimates tokens / cost / time with ranges, offers several ways
to do the work, enforces a hard budget cap, requires a recorded approval, and — after
execution — collects what actually happened and compares it to what was estimated.

It does **not** execute tasks, drive agents, select models at runtime, verify content,
own product memory, or replace the Orchestrator. The Orchestrator consumes an approved
plan; it does not ask the Planner what to do next.

### Relationship to §2

The §2 research is **closed** (`d6d41f4`), with an official negative result and all
artifacts frozen and immutable. The Planner is a **new product module**, not a
continuation of that research, and it may not modify anything under `experiment/s2/`
or `corpus/`.

What does carry across is *methodology*, not data:

| §2 lesson | Where it shows up here |
|---|---|
| Money is `Decimal`, never `float` | `money.Money` refuses float construction |
| An estimate must name the price it was made under | `EstimatorVersion.pricing_ref` |
| Price drift invalidates an authorisation | `errors.PricingDriftError` |
| Reserve max exposure *before* sending | `BudgetState.committed` separate from `actual` |
| Design-is-fundable ≠ this-call-may-send | `PlanStatus.APPROVED` is a distinct state from `AWAITING_APPROVAL` |
| An ambiguous call is not a failure and is never auto-retried | `OutcomeStatus.AMBIGUOUS` |
| Raw evidence must be persisted before summarisation | `RawEvidence` + `assert_observability_complete` |
| An effect at n=8 is not an effect | `ConfidenceRange` blocks HIGH below 30 observations |
| Apparatus failures must not train an estimator | `EstimateVariance.is_usable_for_calibration()` |

The last two are the reason the learning layer is a `Protocol` with no implementation.
§2 is the only rigorous experiment this project has run on "learned memory beats
none", and it found no evidence for it (Δ(C−A) = −0.25, n=8, p=0.625). A learned
estimator is therefore an **unsupported hypothesis**, not a scheduled milestone.

---

## 2. Boundaries

| Component | The Planner may | The Planner may not |
|---|---|---|
| **Orchestrator** (`orchestrator/`) | Produce an approved plan it consumes; receive `ActualUsage` back | Drive the graph, schedule, choose retries, or alter existing gate behaviour |
| **Model Registry** (`registry/`) | Read `ModelSpec` for capabilities and price | Select a model — that is the bandit's job |
| **Tool Gateway** (`tools/`) | Read the catalogue and permission tiers to price tool use | Invoke tools or hold credentials |
| **Memory** (`memory/`) | Read historical outcomes to inform an estimate | Write to the playbook. §2's write-gate is deterministic and model-free; contaminating it would invalidate the one clean mechanism in the repo |
| **Verifier** (`verification/`) | Estimate how many verification rounds will cost | Verify anything, or set `passed` |
| **Persistence** (`persistence/`) | Define what must be stored | Own the schema or run migrations |
| **`experiment/s2/`** | Read, analyse, learn from | Edit, move, rename, delete, instrument, or depend on |

Two tests enforce the last row and the purity rule: contracts may not `import`
anything under `experiment`, and may not import `os`, `pathlib`, `sqlite3`,
`subprocess`, `socket`, `httpx`, `requests`, `urllib` or `anthropic`.

---

## 3. The central invariant

**A plan cannot reach `EXECUTING` from `AWAITING_APPROVAL`.**

It must pass through `APPROVED`, and `APPROVED -> EXECUTING` additionally requires an
`ApprovalDecision` that `covers()` the exact run. An approval binds to:

- `plan_id` — not another plan
- `plan_version` **and** `plan_hash` — not an edited plan
- `approved_mode` — not a different execution mode
- `approved_cap` — the projection must still fit inside it
- `valid_until` — if set, it expires

Change any of those and the approval stops covering the run. `assert_may_execute`
fails closed: no decision on record means no permission, raised loudly.

Two further lifecycle rules follow the same logic:

- `APPROVED -> ESTIMATED` exists, so re-planning an approved plan withdraws its
  approval by construction rather than by discipline.
- `PAUSED_BUDGET -> EXECUTING` does **not** exist. Continuing past a cap routes back
  through `AWAITING_APPROVAL`, so an over-cap continuation is always a fresh decision.

---

## 4. Seven numbers that are all called "the cost"

The budget contracts keep these apart deliberately:

```
estimated / expected     what the estimator thinks it will cost
likely range             best..worst around that
worst reasonable         a defensible upper bound — NOT permission to spend it
approved budget          what the operator said yes to, for this plan
hard budget cap          the ceiling execution may never cross
committed spend          reserved for calls in flight, not yet billed
actual spend             reconciled against real provider usage
```

Admission is measured against `committed + actual` (`BudgetState.encumbered`), never
`actual` alone — otherwise two concurrent calls can each see room only one of them
has. `would_exceed` is asked *before* sending; a check that runs after the response
arrives has already lost.

**Provider credits are not a budget.** `BudgetPolicy.reported_provider_credits` exists
so a run can refuse to start when credits are below the next block's exposure, and is
explicitly not a cap. §2 recorded the same field with `is_budget_cap: false`.

---

## 5. Observability is a precondition, not a feature

The §2 closeout could not determine whether the Gate-A failure came from the model,
the prompt, or the parser, because raw responses were not retained. It makes seven
fields mandatory for any future work. `RawEvidence` carries all seven, and
`assert_observability_complete` must pass on a synthetic fixture **and** one dry run
before the first paid call.

`ActualUsage` enforces the coherence rule directly: a call that reached the provider
must carry its evidence; only a call blocked before send may lack it.

---

## 6. Four decisions left open

Each has a `Protocol` in `ports.py` and no implementation anywhere — not even a
trivial default, because a default is a decision nobody remembers making.

### 6.1 Where the package finally lives

**Provisional:** `src/meta_orchestrator/planner/contracts/`, extending the existing
`planner/` package (SPEC §12).

- *Alternatives:* a top-level `src/planner/`; a separate repository.
- *Trade-off:* the current location keeps the SPEC §12 mapping intact and needs no
  build changes, but couples the Planner's release cycle to the orchestrator's.
- *Recommendation:* stay here while the Planner has one consumer. Revisit if a second
  consumer appears — that is the point at which the coupling starts costing something.

### 6.2 Source of truth for pricing

**Port:** `PricingSource`, which must expose an opaque `pricing_ref`.

- *Alternatives:* (a) copy the frozen `experiment/s2/pricing.py` pattern into a
  product module, generalised to multiple models and cache rates; (b) extend
  `ModelSpec` in the Registry; (c) an external pricing service.
- *Trade-off:* (a) is proven and content-addressed but duplicates code; (b) is DRY but
  `ModelSpec` currently stores prices as `float` and has no cache rates, so it would
  need changing first; (c) adds a live dependency for no present benefit.
- *Recommendation:* **(a), by copying rather than extracting a shared base.** The
  frozen module is hash-bound into §2's authorisation chain; refactoring it in place
  risks invalidating that chain, and duplication is far cheaper than that risk.

### 6.3 How confidence ranges are computed

**Port:** `ConfidenceModel`.

- *Alternatives:* fixed multipliers per task family; historical quantiles; a fitted
  distribution.
- *Trade-off:* nothing here has been checked against a single actual, so any method
  chosen now would be asserted rather than measured.
- *Recommendation:* fixed, documented multipliers to begin with, replaced only once
  coverage can be tested — does the stated 80% range actually contain 80% of outcomes?
  Until that question can be answered, the honest default is `Confidence.UNKNOWN`.

### 6.4 The calibration / learning mechanism

**Port:** `Calibrator`, with `may_calibrate()` gating on evidence and
`propose_adjustment()` returning a proposal that is never self-applied.

- *Alternatives:* correction factors from historical means; Bayesian updating; ML.
- *Trade-off:* §2 found no evidence that learned memory beats none, and its result was
  apparatus-dominated. Building a learner before actuals exist repeats that error.
- *Recommendation:* rules plus historical averages plus correction factors, per task
  family, versioned and reversible. No calibration until enough usable observations
  exist for a family on its own — where "usable" excludes apparatus failures and
  unclassified variances by construction.

---

## 7. What P0 deliberately does not contain

No provider calls · no live pricing · no price fetching · no currency conversion · no
active estimator · no statistical model · no ML · no automatic estimator update · no
execution routing · no task execution · no active retries · no production migrations ·
no UI or dashboard · no change to `experiment/s2/` · no change to existing Orchestrator
behaviour · no wiring of the approval rule into the running engine.

---

## 8. Currency

Contracts default to `USD` and hold amounts as `Decimal` with a scale of `1e-8`.
Provider prices are published in USD, and the frozen §2 ledger is in USD, so USD is the
internal accounting currency.

Presentation in ₪ is a rendering concern for a later phase, and no FX source is chosen
here — picking one now would be exactly the sort of irreversible decision P0 avoids.
`Money` refuses to combine currencies rather than converting silently.

---

## 9. Open risk

`ModelSpec.price_per_1k_in/out` are `float` while these contracts are `Decimal`. Until
a `PricingSource` bridges them, any conversion at that boundary reintroduces the
rounding these types exist to prevent. This is a known, deliberate gap in P0 — the
bridge is P1 work and needs its own review.
