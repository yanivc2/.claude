# P1c — Budget Admission and the Approval Gate

**Scope: deciding.** Neither component executes anything, spends anything, or is wired
to the orchestrator. They answer two questions and record the answers:

- `BudgetGuard` — *may this cost be incurred?*
- `ApprovalGate` — *did a person authorise this exact run?*

```
planner/budget/
  reserve.py   ReservePolicy, ReservedAmount — contingency as a visible addend
  ledger.py    ReservationLedger — reserve, reconcile, release, ambiguity
  guard.py     BudgetGuard, AdmissionReport
  errors.py
planner/approval/
  store.py     ApprovalLog — append-only
  gate.py      ApprovalGate, approve(), reject()
  errors.py
```

---

## 1. Contingency is a line item, not a padded rate

This module exists because of G2. The old pre-flight estimate priced every token at the
most expensive model's *output* rate. It inflated the figure and could be mistaken for
a safety margin — but it was a wrong rate that happened to err upward. The difference
matters: a wrong rate cannot be reasoned about, tuned, or switched off, and nobody can
say how much head-room it actually bought.

So a reserve is always:

```
authorised = quoted + reserve
```

with `quoted` untouched, `reserve` computed from a stated `ReservePolicy`, and both
visible in the `AdmissionReport`. The default is 25% of the quoted worst case,
matching the reserve fraction §2's budget projection was authorised under — carried as
a documented default with its rationale rather than as a hidden constant. `basis` may
be `NONE`, `FRACTION_OF_WORST`, `FRACTION_OF_EXPECTED` or `FIXED_AMOUNT`, and a policy
with no rationale is rejected.

A fraction above 1.0 is refused: if more than doubling the quote is genuinely intended,
it has to be stated as a `FIXED_AMOUNT` so it is visible.

`test_the_reserve_is_what_tips_a_marginal_plan_over` pins the behaviour — the same
projection admits with no reserve and blocks with one, and the difference is a number
anyone can point at.

---

## 2. Admission

Asked **before** money moves. A check that runs after the response arrives has already
lost: the tokens are billed whatever it decides.

| Rule | Why |
|---|---|
| measured against `committed + actual` | otherwise two calls in flight each see room only one has |
| a non-authoritative price raises | fictional rates produce clean arithmetic and a meaningless answer |
| an unavailable price blocks | never assume zero for a missing rate |
| a currency mismatch blocks | no conversion exists at this layer |
| thresholds fire once | a repeated warning is noise, and noise is how a real one gets ignored |

`AdmissionReport` carries the decision *and* the working: what was requested, what the
contingency added, the position before and after, the cap, and which thresholds this
admission newly crosses. A caller can explain the outcome without recomputing it.

**Non-authoritative prices.** `admit()` raises `NonAuthoritativePriceError` for
`FICTIONAL`, `TEST_ONLY` and `UNVERIFIED` trust classes. `allow_non_authoritative=True`
exists for dry runs and tests; it admits, and stamps the report with "this is not a
real budget". The default is the strict one.

**Provider credits.** `credits_cover()` is a separate method that returns `None` when
nothing was reported. Credits are operator-reported runtime state — a healthy balance
does not widen the cap, and a test asserts a $500 balance still blocks against a $10
cap.

**Checkpoints** do not re-add the contingency. It was taken at admission; compounding
it per call would bury it again, which is the same class of error as putting it in the
rate.

---

## 3. The reservation ledger

`check → reserve → (spend) → reconcile`, modelled on §2's call journal.

- `reserve()` holds an amount against the cap or raises. Because the hold happens
  first, an overrun is not reachable without this call having succeeded.
- `reconcile()` replaces the hold with what was actually billed.
- `release()` frees a hold for a call that provably never reached the provider, and
  requires a stated reason.
- `mark_ambiguous()` records that it is unknown whether the provider billed. **The
  hold is deliberately not freed.** Quietly releasing it would let the same budget be
  spent twice. There is no auto-retry, and this is not a failure — it is a state a
  human resolves.
- `resolve_ambiguous()` requires an attributed decision and either a billed amount or
  an explicit "not billed".

Settling twice raises. The ledger is immutable — every operation returns a new one —
which makes the state machine reviewable and removes a class of concurrent-mutation
bug by construction.

In-memory. P1c is not authorised to add persistence; the semantics are what matter for
review, and a durable implementation slots in behind the same surface.

---

## 4. The approval gate

**Nothing executes without a record that covers the exact run.** `authorise()` fails
closed on each of: no decision on record, a different plan, a different version, a
different hash, a different execution mode, a projection grown past the approved cap,
an expired approval, or no price at all.

**Editing an approved plan withdraws its approval by construction** — the approval
binds to `plan_hash`, so a changed plan simply is not covered. `supersede()` makes that
explicit by *appending* supersession records; the original approval stays readable, so
"what were we authorised to do last Tuesday" remains answerable.

**Records are append-only.** Writing the same decision id twice raises. A changed mind
is a new record. An authorisation that can be quietly widened after the fact authorises
nothing — which is why §2 minted a separate execution grant rather than reusing its
Gate-1 anchor.

A decision is checked against the request it claims to answer: same plan, same version,
same hash. An approved cap below the request's expected cost is refused at recording
time, because approving it would guarantee a mid-run halt.

**Expiry needs a clock.** `is_effective()` takes `now` explicitly rather than reading
one, so the gate stays a pure predicate. An expiring approval evaluated without a clock
is treated as not in force — the safe reading.

---

## 5. Lifecycle

`may_transition()` combines the two halves of the rule:

- the transition table forbids `AWAITING_APPROVAL -> EXECUTING` outright;
- `APPROVED -> EXECUTING` additionally needs a decision covering the run, which the
  table alone cannot express.

`PAUSED_BUDGET -> EXECUTING` does not exist. Continuing past a cap routes back through
`AWAITING_APPROVAL`, so an over-cap continuation is always a fresh decision.

---

## 6. Worked example

A plan projected at $20 expected / $40 worst, a $100 cap, 25% contingency:

```
admission   quoted   40.00        (the projection's worst case)
            reserve  10.00        (25% of worst, FRACTION_OF_WORST)
            total    50.00  ADMIT, 50.00 of 100.00 remains

approval    request  expected 20.00, worst 40.00, proposed cap 50.00
            decision d1 by yaniv, approved_cap 50.00, mode AUTOMATIC
            authorise -> d1        (plan hash-v1 v1 matches, 40 <= 50)

ledger      reserve  call-1  50.00      committed 50.00, actual  0.00
            reconcile call-1 22.00      committed  0.00, actual 22.00
            remaining 78.00
```

Nothing was executed. `test_worked_example_price_admit_approve_reserve_reconcile`
walks exactly this.

---

## 7. Boundaries

Tested, not asserted:

- no import of `experiment/` from either package;
- no `socket`, `http`, `httpx`, `requests`, `urllib`, `anthropic`, `subprocess`,
  `sqlite3`, `ssl`, `asyncio`, `os`, `pathlib` or `io`;
- the orchestrator source contains no reference to `planner.budget`,
  `planner.approval`, `BudgetGuard` or `ApprovalGate`;
- neither class exposes a public `execute`, `run`, `send`, `spend`, `charge` or
  `call_model`.

Test projections are built from **real quotes on real cards** rather than
hand-assembled. A synthetic projection could carry a combination the pricing module
would never produce, and the guard would then be tested against a shape that cannot
occur.

---

## 8. Open

- Persistence for the ledger and the approval log — in-memory only.
- Wiring to the orchestrator — a separate, explicitly authorised integration step.
- `reported_provider_credits` is recorded but nothing refreshes it.
- Reserve defaults to 25% on the strength of §2's projection, which was a different
  workload. It is a documented starting point, not a measured one.
- G1 remains **REPLACEMENT_READY, not FIXED**.
