"""The store and its unit of work — where atomicity actually happens.

A ``GovernanceStore`` owns one database path. Every budget-changing operation runs
inside a unit of work that:

1. takes SQLite's write lock immediately (``BEGIN IMMEDIATE``), so two writers cannot
   both read the same balance and only discover the conflict at commit;
2. compare-and-swaps the budget row on its snapshot hash, so a writer that *did* slip
   in between the read and the write is caught rather than overwritten;
3. commits every record and every event together, or none of them.

Both layers are needed. The lock stops the common case; the CAS catches the case where
the caller read the snapshot before the transaction began — which is the normal shape
of this API, since admission and approval happen well before the reservation.

> **Single-database transactional safety: implemented.**
> **Multi-node distributed coordination: not implemented.**
>
> One SQLite file, one machine. Nothing here coordinates across hosts, and the
> guarantee should not be described as if it did.
"""
from __future__ import annotations

import sqlite3
from typing import Callable, Optional

from ..governance.snapshots import BudgetSnapshot
from .connection import Clock, FaultPoint, initialize, open_existing
from .errors import ConcurrentBudgetModificationError, RecordNotFoundError, TransactionError
from .records import dump
from .repositories import (
    SqliteAdmissionStore,
    SqliteApprovalStore,
    SqliteAuthorizationStore,
    SqliteBudgetSnapshotStore,
    SqliteGovernanceEventStore,
    SqliteIdempotencyStore,
    SqliteOverrideStore,
    SqlitePlanSnapshotStore,
    SqliteReservationStore,
    SqliteSettlementStore,
)
from .schema import CANONICAL_SERIALIZATION_VERSION, SCHEMA_VERSION


class GovernanceUnitOfWork:
    """One transaction. Committed on a clean exit, rolled back on any exception."""

    def __init__(self, conn: sqlite3.Connection, now: Callable[[], str],
                 faults: FaultPoint) -> None:
        self._conn = conn
        self._faults = faults
        self._entered = False
        self.budgets = SqliteBudgetSnapshotStore(conn, now)
        self.plans = SqlitePlanSnapshotStore(conn, now)
        self.approvals = SqliteApprovalStore(conn, now)
        self.authorizations = SqliteAuthorizationStore(conn, now)
        self.reservations = SqliteReservationStore(conn, now)
        self.settlements = SqliteSettlementStore(conn, now)
        self.overrides = SqliteOverrideStore(conn, now)
        self.events = SqliteGovernanceEventStore(conn, now)
        self.idempotency = SqliteIdempotencyStore(conn, now)
        self.admissions = SqliteAdmissionStore(conn, now)
        self._now = now

    def __enter__(self) -> "GovernanceUnitOfWork":
        if self._entered:
            raise TransactionError("a unit of work cannot be re-entered")
        if self._conn.in_transaction:
            raise TransactionError(
                "a transaction is already open on this connection — units of work do "
                "not nest, because a partial rollback of a budget change is not a thing")
        self._conn.execute("BEGIN IMMEDIATE")
        self._entered = True
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if exc_type is not None:
            self._conn.execute("ROLLBACK")
            return
        try:
            # A fault raised here must still roll back. Leaving the transaction open
            # would let the *same connection* read its own uncommitted writes, which
            # looks exactly like a partial commit to everything downstream.
            self._faults.check("before_commit")
        except Exception:
            self._conn.execute("ROLLBACK")
            raise
        self._conn.execute("COMMIT")

    def fault(self, name: str) -> None:
        """Test-only fault point. No-op unless a test armed this name."""
        self._faults.check(name)

    # --- the guarded write ---
    def register_budget(self, snapshot: BudgetSnapshot) -> None:
        """Create a budget row and its first snapshot.

        The budget row goes in first: ``budget_snapshots`` carries a foreign key to it,
        so the parent has to exist before the child. Both are in the same transaction,
        so a half-registered budget is not reachable.
        """
        _, digest = dump(snapshot)
        self._conn.execute(
            "INSERT INTO budgets (budget_id, currency, current_snapshot_hash, "
            "snapshot_version, updated_at) VALUES (?, ?, ?, ?, ?)",
            (snapshot.budget_id, snapshot.currency, digest,
             snapshot.snapshot_version, self._now()))
        self.budgets.put(snapshot)

    def compare_and_swap_budget(self, *, budget_id: str, expected_hash: str,
                                new_snapshot: BudgetSnapshot) -> None:
        """Advance the budget only if it is still where the caller last saw it.

        The ``WHERE current_snapshot_hash = ?`` clause is the whole mechanism: a
        concurrent writer that already advanced the row leaves zero rows matching, and
        the transaction is abandoned rather than committing against a moved balance.
        """
        self.budgets.put(new_snapshot)
        _, digest = dump(new_snapshot)
        cursor = self._conn.execute(
            "UPDATE budgets SET current_snapshot_hash = ?, snapshot_version = ?, "
            "updated_at = ? WHERE budget_id = ? AND current_snapshot_hash = ?",
            (digest, new_snapshot.snapshot_version, self._now(), budget_id,
             expected_hash))
        if cursor.rowcount == 0:
            raise ConcurrentBudgetModificationError(budget_id, expected_hash)


class GovernanceStore:
    """Owns one database. Hands out units of work and read-only repositories.

    The path is injected — there is no default and no module-level instance. A
    governance store that quietly picks its own file is a store nobody can point at.
    """

    def __init__(self, path: str, *, clock: Clock, create: bool = True) -> None:
        self._path = path
        self._clock = clock
        self._faults = FaultPoint()
        self._conn = (initialize(path, clock=clock) if create
                      else open_existing(path))
        self._now = clock.now_iso

    # --- identity ---
    @property
    def path(self) -> str:
        return self._path

    @property
    def schema_version(self) -> str:
        return SCHEMA_VERSION

    @property
    def serialization_version(self) -> str:
        return CANONICAL_SERIALIZATION_VERSION

    @property
    def connection(self) -> sqlite3.Connection:
        return self._conn

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "GovernanceStore":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    # --- transactions ---
    def unit_of_work(self) -> GovernanceUnitOfWork:
        return GovernanceUnitOfWork(self._conn, self._now, self._faults)

    def arm_fault(self, name: str) -> None:
        """Test-only. Arms the next matching fault point, then disarms itself."""
        self._faults.arm(name)

    def disarm_faults(self) -> None:
        self._faults.disarm()

    # --- read-only repositories, outside any transaction ---
    @property
    def budgets(self) -> SqliteBudgetSnapshotStore:
        return SqliteBudgetSnapshotStore(self._conn, self._now)

    @property
    def plans(self) -> SqlitePlanSnapshotStore:
        return SqlitePlanSnapshotStore(self._conn, self._now)

    @property
    def approvals(self) -> SqliteApprovalStore:
        return SqliteApprovalStore(self._conn, self._now)

    @property
    def authorizations(self) -> SqliteAuthorizationStore:
        return SqliteAuthorizationStore(self._conn, self._now)

    @property
    def reservations(self) -> SqliteReservationStore:
        return SqliteReservationStore(self._conn, self._now)

    @property
    def settlements(self) -> SqliteSettlementStore:
        return SqliteSettlementStore(self._conn, self._now)

    @property
    def overrides(self) -> SqliteOverrideStore:
        return SqliteOverrideStore(self._conn, self._now)

    @property
    def events(self) -> SqliteGovernanceEventStore:
        return SqliteGovernanceEventStore(self._conn, self._now)

    @property
    def idempotency(self) -> SqliteIdempotencyStore:
        return SqliteIdempotencyStore(self._conn, self._now)

    @property
    def admissions(self) -> SqliteAdmissionStore:
        return SqliteAdmissionStore(self._conn, self._now)

    def current_snapshot(self, budget_id: str) -> Optional[BudgetSnapshot]:
        try:
            return self.budgets.current(budget_id)
        except RecordNotFoundError:
            return None
