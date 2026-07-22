# v3 Pre-Registration DRAFT (not yet in force — thresholds finalize before any paid call)

DRAFT. A v3 paid micro-pilot may begin only after this document is finalized + frozen and a new
budget is approved. Nothing here authorizes spending.

## Gate A — output-contract validity (no memory)

- **Design:** same held-out tasks + same sanitized prompts as v2.2 fold-1, A-condition only (no
  memory), two arms: v2.2 SEARCH/REPLACE contract vs v3 JSON unique-anchor contract (+ one bounded
  malformed/truncated repair-retry). Paired by task.
- **Primary metric:** valid-applied-patch rate (a cell reaches the grader with an applied patch).
- **Proposed Go thresholds (to finalize before paid calls):**
  ```
  parser acceptance on well-formed fixtures   100%   (already MET offline)
  ambiguous application                        0%    (already MET offline)
  silent partial application                   0%    (already MET offline)
  deterministic replay                        100%   (already MET offline)
  ── model-side, measured in the paid micro-pilot ──
  valid applicable patch rate               >= 90%
  malformed output rate                      <= 5%
  apply-failure rate                         <= 5%
  silent fallback events                        0
  ```
- **Decision:** if the model-side targets are met → proceed to Gate B. If not → do NOT run a
  learning experiment on this apparatus; iterate the contract or close the research.

## Gate B — learning (only if Gate A passes)

- **Design:** conditions A / C / D / B1 under the robust contract; C trained via the separated
  solver→verifier→distiller pipeline with two-tier routing; held-out evaluation; sealed outcomes;
  one-shot deterministic unseal under a v3 blinded analysis plan.
- **Primary estimand:** Δ(C−A) at task level (unit = task), exact paired McNemar/sign test, frozen
  before unseal — identical statistical machinery to v2.2's plan.
- **Sample:** enough held-out tasks for the paired test to have power (see V3_COST_AND_POWER_PLAN.md);
  fold-1's 8 is a pilot floor, not a target.
- **Claim discipline:** directional pilot unless a properly-powered confirmatory run is separately
  pre-registered; cross-fold / cross-project generalization stays NOT_ESTABLISHED until tested.

## Invariants carried from v2.2 (non-negotiable)

Hidden F2P is the primary outcome; public never is. Token parity for C vs B1. Label-free
injection + condition-label fail-closed. Single-use grants + atomic budget + frozen pricing/caps.
Sealed outcomes + pre-frozen analysis plan + deterministic one-shot unseal. Train-only,
leak-screened, capped write-gate. No silent fallback. v2.2 results/bank remain immutable.

## What finalizing this draft requires

Operator sign-off on the model-side Gate-A thresholds; a funded budget; a frozen v3 manifest +
apparatus-version hash; and a v3 blinded analysis plan (mirroring S2_FOLD1_BLINDED_ANALYSIS_PLAN.md).
