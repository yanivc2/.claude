# P1d — Transactional Persistence

**Not "saving files".** A store that persisted records but let two callers spend against
one balance would leave the central risk exactly where it was. The point of this phase
is that **reserve, settle and override are atomic against the same budget snapshot**.

```
planner/persistence/
  errors.py        fail-closed persistence errors
  schema.py        tables, indexes, pragmas, schema version
  connection.py    connection factory, explicit migrations, test-only fault points
  records.py       artifact -> record, and the verified way back
  rebuild.py       payload -> domain artifact, through its own constructor
  repositories.py  SQLite repositories, parameterised SQL only
  store.py         GovernanceStore + GovernanceUnitOfWork (BEGIN IMMEDIATE + CAS)
  service.py       BudgetService — the atomic reserve / settle / override flows
  ports.py         storage ports; the domain never imports SQLite
```

---

## 1. Two locking mechanisms, both needed

| Mechanism | Catches |
|---|---|
| `BEGIN IMMEDIATE` | two writers inside overlapping transactions — the write lock is taken at the *start*, not at first write |
| compare-and-swap on `current_snapshot_hash` | a writer who committed *before* this transaction opened |

The second is not redundant. The normal shape of this API is that admission and
approval happen minutes before the reservation, so the caller arrives holding a
snapshot hash from earlier. `BEGIN IMMEDIATE` alone would happily commit against a
balance that moved in between; the CAS is what refuses.

Zero affected rows on the CAS raises `ConcurrentBudgetModificationError`, and the whole
transaction is abandoned — nothing partial is written.

> **Single-database transactional safety: implemented.**
> **Multi-node distributed coordination: not implemented.**

One SQLite file, one machine. No distributed lock, no replication.

---

## 2. Transaction boundaries

Every mutating operation is one unit of work:

```
BEGIN IMMEDIATE
  -> re-read the current snapshot inside the lock
  -> compare with the snapshot the caller decided against   (StaleSnapshotError)
  -> validate in the domain
  -> write records
  -> compare-and-swap the budget row                        (ConcurrentBudgetModification)
  -> append events
COMMIT
```

Transactional: reserve, settle, release, mark-ambiguous, resolve-ambiguous, apply
override, register budget. Units of work do not nest — a partial rollback of a budget
change is not a thing, and the attempt raises.

---

## 3. Atomic reservation

```
idempotency lookup  -> identical retry returns the original, holds nothing new
current snapshot    -> re-read under the lock
expected hash       -> StaleSnapshotError if the caller is behind
cap check           -> InsufficientBudgetError, nothing written
insert reservation
CAS the budget      -> committed_spend += amount, version += 1
record idempotency
append event
COMMIT
```

There is no window in which a reservation exists but the balance does not reflect it,
none in which the balance moved but the reservation was not written, and none in which
an event describes something that did not happen. Four injected fault points —
`after_reservation_insert`, `after_snapshot_update`, `after_event_append`,
`before_commit` — each assert that the budget, the reservations, the events and the
idempotency record are all untouched afterwards, both on the same connection and after
a restart.

---

## 4. Settlement and overrun

Settlement moves `committed -> actual` in one transaction: advance the reservation,
write the `SettlementResult`, CAS the budget, append the event.

**An overrun does not settle.** Settling above the reservation leaves the hold in
place, writes an `OVERRUN_DETECTED` event, and returns `review_required=True`. The
budget snapshot is byte-identical afterwards and the cap is not widened. Absorbing the
difference silently would be indistinguishable from having no cap.

---

## 5. Persistent idempotency

`idempotency_keys` stores the key, the operation, the canonical request hash, and the
resulting entity's id and hash.

- Same key, same request → returns the original reservation, holds nothing new.
- Same key, **different** request → `IdempotencyConflictError`.

This survives restart, which is the whole reason it is a table. An in-memory map
forgets exactly when it matters — after the restart that followed the ambiguous call.

---

## 6. Recovery

Tested by closing the store and opening a **new** one against the same file, not by
reusing a connection. After a restart: the reservation is still `COMMITTED`, the
committed spend is still held, the approval and authorization rebuild and re-hash
cleanly, the idempotency key still suppresses a repeat, and the reservation can still
be settled or released.

`open_existing` will not create tables and will not migrate — a wrong schema is
discovered immediately rather than midway through a transaction.

---

## 7. Ambiguity across a restart

An `AMBIGUOUS` reservation **keeps its hold**, survives restart, and is never released
automatically. `ambiguous_for_budget()` returns it as work requiring a human.
`resolve_ambiguous` demands an actor and an explicit billed/not-billed decision, and is
itself transactional. There is no automatic retry of the original call.

---

## 8. Storage format and integrity

One serialization. The **canonical payload** an artifact already hashes for its
identity is what gets stored, alongside that hash — there is no second format that
could disagree with the first.

Writing: build the artifact (domain validation runs) → canonical payload → full
SHA-256 → store both.
Reading: load payload → recompute hash → compare → rebuild through the artifact's own
constructor (domain validation runs again).

Both checks are in the path. The hash catches a payload edited outside the application;
the rebuild catches a payload that is intact but no longer satisfies the rules. Either
failure raises `CorruptRecordError` — a governance record that might be wrong is worse
than one that is missing, because the missing one stops you.

**Not recovered:** fields deliberately excluded from an artifact's identity.
`BudgetSnapshot.provider_credits` is the case — operator-reported runtime state, kept
out of the hash so it cannot invalidate approvals, and therefore not part of what a
restore restores. `taken_at` comes back from the row's own timestamp column.

---

## 9. Append-only audit

`approvals`, `authorizations`, `overrides`, `settlements`, `governance_events`,
`budget_snapshots`, `plan_snapshots`, `admissions` and `approval_requests` have **no
update path in the repositories at all** — not a guarded one, not a private one. The
guarantee is structural rather than disciplined: there is no method to call, and a
duplicate insert raises `AppendOnlyViolationError`.

A supersession is a new record. The original stays readable, which is what makes "what
were we authorised to do last Tuesday" answerable.

Reservations are the one artifact whose status legitimately advances, and every step is
also appended to `reservation_history`, so the advance is auditable rather than
destructive.

---

## 10. Schema and migrations

- `SCHEMA_VERSION = planner_persistence_schema_v1`
- `CANONICAL_SERIALIZATION_VERSION = canonical_v1` — kept separate, because a payload
  format change is not a table change and conflating them makes one look like the other.

`initialize`, `migrate` and `verify_schema` are explicit calls. **Nothing migrates
implicitly**: an unnoticed migration during an import is how a budget ledger gets
rewritten by a process nobody was watching. Migrations are ordered, idempotent, and
each runs in its own transaction. There is no automatic downgrade.

---

## 11. Security

- `foreign_keys = ON`, and a test proves the constraint is enforced rather than merely
  declared.
- `journal_mode = WAL`, `synchronous = FULL`, `busy_timeout = 5000`, applied to **every**
  connection — SQLite scopes most of these per-connection, and one that skipped them
  would behave differently from the rest.
- Parameterised SQL only. Two tests enforce it: an allow-list of the structural
  identifiers that may be interpolated (`TABLE`, `table`, `names`, `holes`, `where`),
  and a check that every statement containing `?` passes a parameter tuple.
- The database path is injected. No default, no module-level singleton, no global — a
  governance store that quietly picks its own file is a store nobody can point at.
- No prompts, no raw responses, no API keys, no provider credentials. A test walks
  every table and every row looking for them.

**SQLite does not encrypt data at rest**, and nothing here adds a home-made substitute.
File permissions are the operator's responsibility.

---

## 12. Timestamps

Nothing in this layer reads a clock. A `Clock` is injected into the store and the
migrations; artifacts carry the instants they were given. Recovery therefore returns
the same instant that was written, and the tests are deterministic.

---

## 13. Legacy guard and gate

`planner/governance/` is **the canonical path** for every new consumer.

`planner/budget/` and `planner/approval/` are marked `LEGACY — do not use for new
integrations` in their module docstrings. They keep working for the tests already
written against them. They get **no persistence of their own** — a second store would
mean two answers to "what is committed right now" — no new features, and no place in
the orchestrator integration. Tests enforce all three.

They were not deleted: removing them would break a working suite for no gain, and the
designation is what actually prevents new use.

---

## 14. What is still not connected

The orchestrator is untouched. A test reads its source and asserts it contains no
reference to `planner.persistence`, `planner.governance`, `GovernanceStore` or
`BudgetService`.

```
G1 — Runtime status:      still active in Orchestrator (chars // 4)
     Product replacement: implemented and tested
     Governance layer:    implemented and tested
     Persistence layer:   implemented and tested
     Integration status:  not connected
     Overall status:      REPLACEMENT_READY, not FIXED
```

---

## 15. Limits

- One database, one machine. No distributed coordination.
- No encryption at rest.
- A content hash is not a signature — it shows an artifact is unmodified, and attests
  nothing about who wrote it.
- Fault injection exists for crash-consistency tests and is not exported from the
  package.
- No automatic schema downgrade.
