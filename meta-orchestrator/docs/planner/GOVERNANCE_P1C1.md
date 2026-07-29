# P1c.1 — Governance Completion

Completes the governance layer over the P1c core. Nothing here executes, persists, or
reaches the network, and none of it is wired to the orchestrator.

```
planner/governance/
  purpose.py        SpendPurpose — REAL_SPEND vs SIMULATION
  canonical.py      canonical serialization + full SHA-256
  snapshots.py      BudgetSnapshot, PlanSnapshot
  conditions.py     blocking / acknowledgeable / informational
  freshness.py      PriceFreshnessPolicy
  binding.py        ApprovalBinding — every identity an approval is tied to
  admission.py      GovernedBudgetGuard, GovernedAdmission
  gate.py           GovernedApprovalGate, request, decision
  authorization.py  ExecutionAuthorization, UsageCeiling
  override.py       BudgetOverride, OverrideOutcome
  reservation.py    SpendReservation lifecycle + idempotency
  events.py         governance events
  errors.py
```

---

## 1. Why the reserve default is `NONE`

The P1c implementation defaulted to a 25% contingency. That was wrong, and it is
corrected here.

**A contingency that arrives by default is a contingency nobody decided on**, and
within a week it reads as part of the price. The whole reason this layer separates
`quoted + reserve` — rather than repeating G2's padded rate — is so head-room is a
visible, attributable choice. Making it automatic gives back exactly what the
separation was for.

So: `ReservePolicy()` is `NONE`, and `GovernedBudgetGuard()` applies nothing.

## 2. Why 25% is a named opt-in

`ReservePolicy.s2_derived_25_percent_heuristic()` — `S2_DERIVED_25_PERCENT_HEURISTIC`.

The figure is the reserve fraction §2's budget projection was authorised under. That
was **a different workload**: a single frozen Haiku model, two rounds per task, a $50
global cap. Nothing has measured it against product traffic. The policy name and the
rationale both carry that, so it cannot quietly become "the standard 25%", and a test
asserts the rationale still says `§2`, `different workload`, `Heuristic` and
`never measured`.

**Permitted for real spend:** `NONE`, `FIXED_AMOUNT`, `FRACTION_OF_WORST`.

`FRACTION_OF_EXPECTED` is excluded: sizing head-room from the *expected* case leaves
the worst case systematically under-covered, which is the opposite of what a
contingency is for. It must be constructed with `experimental=True` and is usable only
under `SIMULATION`; using it for a real admission raises
`RESERVE_MODE_NOT_PERMITTED`, which is blocking.

Changing a reserve policy changes its content hash, which changes the admission hash,
which invalidates any approval bound to it.

---

## 3. `REAL_SPEND` vs `SIMULATION`

`allow_non_authoritative=True` was a boolean, and a boolean does not say what it is
for. "Permit an untrustworthy price" and "this is a rehearsal" are different intents
that happened to need the same relaxation.

| | `REAL_SPEND` | `SIMULATION` |
|---|---|---|
| Trust classes | `PROVIDER_VERIFIED`, `REPOSITORY_VERIFIED` only | any |
| Partial estimate | blocking | allowed |
| Missing deliverables | blocking | allowed |
| Artifact markers | none | `NOT_ELIGIBLE_FOR_REAL_SPEND` |

**Promotion is one-way and forbidden upward.** `assert_not_promotable` refuses to let a
simulation decision authorise real spend: the checks that were relaxed cannot be
performed retroactively by relabelling. The reverse is fine — real-spend authority
covers a rehearsal, because every check that mattered was made.

---

## 4. Snapshots

**`BudgetSnapshot`** — budget id, policy id and hash, currency, hard cap, effective
cap, actual and committed spend, approved override ids, version. Content-hashed; any
money field moving changes the identity.

`provider_credits` is carried but **excluded from the hash**. It is operator-reported
runtime state that drifts for reasons unrelated to this plan, and letting it invalidate
approvals would train everyone to re-approve reflexively.

An `effective_cap` above the `hard_cap` requires an approved override to justify it;
below it is refused outright — an override may only raise a ceiling.

**`PlanSnapshot`** — computed **from the plan**, not taken on trust.
`ExecutionPlan.plan_hash` is a field a caller fills in, and therefore a field a caller
can get wrong or leave stale. `PlanSnapshot.of()` derives the identity from stages,
dependencies, models, deliverables, exclusions, trade-offs, human tasks and the
estimator ref, so two plans declaring the same `plan_hash` still differ if their
content differs. `declared_hash_matches` reports the discrepancy without relying on it.

> **Logical snapshot protection: implemented.**
> **Transactional concurrency protection: not implemented.**
>
> Snapshots detect that state moved between admission and authorization. They do not
> serialise concurrent writers — two processes with no shared store can each hold a
> snapshot that was accurate when taken. Nothing here prevents that, and nothing should
> be described as if it does. That needs persistence.

---

## 5. Full binding

An approval is never "yes, up to $50". `ApprovalBinding` ties it to fifteen
identities: plan hash and version, estimate audit hash, estimator version, ruleset
version, projection hash, price card id and content hash, pricing catalog version,
budget policy hash, budget snapshot hash, admission hash, purpose, execution mode,
reserve policy hash, approved commitment.

`diff` names *which* field moved — "the approval no longer applies" is not an
actionable message. Every hash field must be a full 64-hex digest; a display hash is
refused, because an approval bound to a truncated hash is bound to nothing.

---

## 6. Blocking vs acknowledgeable

Severity is a property of the **code**, not of the caller. A `Condition` constructed
with a mismatched severity raises.

**Blocking** — cannot be waived by anyone: budget breach, non-authoritative price in
real spend, fictional price in real spend, worst cost unavailable, unbounded estimate,
partial estimate in real spend, stale snapshot, currency mismatch, invalid hash,
expired admission, price too old, reserve mode not permitted, missing deliverables,
purpose mismatch.

**Acknowledgeable** — a real judgement the approver may make, on the record:
confidence `UNKNOWN`, heuristic estimator, time estimate unavailable, price
`REPOSITORY_VERIFIED` rather than provider-verified, `n//2` retry heuristic, repeated
context without a cache discount, human-only plan without review, no freshness policy.

`Acknowledgement` **refuses to be constructed for a blocking code.** Approval refuses
while any required acknowledgement is missing, and refuses outright while anything
blocking stands. Collapsing the two is how a governance layer becomes theatre:
everything becomes a checkbox, and the checkboxes all get ticked.

---

## 7. Price freshness

`PriceFreshnessPolicy(maximum_price_age_days=…, require_verification_date=…)`.

- **Configured:** an over-age price raises `PRICE_TOO_OLD` (blocking). No fallback to
  the stale value, no automatic lookup — refusing is the point.
- **Not configured:** `NO_PRICE_FRESHNESS_POLICY` (acknowledgeable). Nobody may later
  claim the price was checked against the provider at execution time.
- An unparseable or missing date is **not evidence of freshness**.

Dates are compared by day arithmetic with `as_of` injected, so this reads no clock.
Existing trust classes are unchanged.

---

## 8. `ExecutionAuthorization`

Returning a decision id was not enough. A decision says a person said yes; an
authorization says **what** they said yes to, in terms an executor can be held to:
permitted provider and model, permitted mode, `UsageCeiling` (calls, input tokens,
output tokens, retries, verification rounds), approved commitment and reserve, validity
window, stop conditions, acknowledgements, and the full binding.

A real-spend authorization with **no** ceiling at all is refused: unlimited permission
is not permission.

> **A content hash is not a signature.** It proves the artifact is unmodified since
> hashing. It attests nothing about who issued it, and nothing in this layer performs
> cryptographic authentication. The caveat is stored on the artifact itself
> (`HASH_IS_NOT_A_SIGNATURE`) so nobody has to go looking for it.

---

## 9. Stale-state refusal

At authorization the current `BudgetSnapshot` is compared with the one the decision was
bound to. Different hash → `StaleSnapshotError`, no authorization, re-admit and
re-approve.

The tested scenario is exactly the one that matters: admit → approve → someone else
spends → snapshot moves → authorization refused, and an `AUTHORIZATION_REFUSED` event
is recorded.

---

## 10. Override lifecycle

An override raises a cap and **invalidates everything below it**: new snapshot → the
admission no longer applies → the approval bound to it no longer applies → the
authorization issued under it no longer applies. `OverrideOutcome` refuses to be
constructed with a partial cascade, because a partial cascade is how an override
becomes a bypass.

Every override names an actor, a reason, an original and new cap, its own approval
decision, an expiry, and binds to a specific plan hash and admission hash — both full
digests. It must raise the ceiling. There is no unlimited override.

---

## 11. Reservations

Statuses: `PROPOSED`, `COMMITTED`, `RELEASED`, `SETTLED`, `EXPIRED`, `AMBIGUOUS`, with
a transition table that refuses everything absent from it — double commit, double
settle, release-after-settle, settle-after-release.

**Idempotency.** The same key with an identical payload returns the original
reservation. The same key with *different* content raises `IdempotencyConflictError` —
the caller believes it is retrying and is in fact asking for something else.

**Ambiguity never auto-releases.** A call that may or may not have been billed keeps
its hold; freeing it would let the same budget be spent twice.

**Overruns are recorded, never absorbed.** `SettlementResult` refuses to be constructed
with an overrun and `review_required=False`, and settling above the reservation does
not touch the cap.

Every reservation carries reservation id, idempotency key, authorization id, budget id,
plan id, amount, reserve component, currency, status — plus a full content hash and a
separate payload hash for the idempotency comparison.

---

## 12. Events

Eighteen event types covering admission, approval, authorization, reservation,
overrun and override. Each is content-hashed and carries `subject_hashes` naming the
artifacts it refers to, so an event can be joined to them without embedding them.

**No persistence** — these are artifacts, and storing them is a later phase. **No raw
prompts**: an event records that a call was authorised and what bounded it, never the
content. A governance log that accumulates prompt text becomes the largest
uncontrolled data store in the system; a test asserts no event payload carries
`prompt` or `raw_response`.

---

## 13. Hashing

Every governance artifact implements `canonical_payload()` and inherits
`content_hash()` — a full 64-hex SHA-256 — and `display_hash()`, a 16-character
prefix **for reading only**, never for identity, binding, or addressing.

Canonical JSON sorts keys, uses compact separators, and renders money as strings.
Serializing a `float` raises: a canonical form that round-trips through binary
floating point is not canonical.

---

## 14. Deliverables

`ExecutionPlan.deliverables` is bound into the plan's identity, so changing what a plan
produces invalidates an approval granted for the old set — an approval is for a
specific piece of work, not for a budget in the abstract.

An empty list blocks real spend unless `produces_no_artifact=True` is set, which exists
for work that legitimately produces nothing (a pure analysis, a dry run).

---

## 15. What this layer still does not do

- **No persistence.** Snapshots, decisions, authorizations, reservations and events all
  live in memory and disappear with the process.
- **No transactional concurrency.** See §4.
- **No signatures.** See §8.
- **No wiring.** The orchestrator is untouched; G1 remains **REPLACEMENT_READY, not
  FIXED**.
- **Reserve figures are unmeasured.** The one non-zero policy is an opt-in heuristic
  from a different workload.
