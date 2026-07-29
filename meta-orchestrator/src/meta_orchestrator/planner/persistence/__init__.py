"""Transactional persistence for governance artifacts (P1d).

Not "saving files". The point is that **reserve, settle and override are atomic against
the same budget snapshot** — a store that persisted records but let two callers spend
against one balance would leave the central risk exactly where it was.

Two mechanisms, both needed:

* ``BEGIN IMMEDIATE`` takes SQLite's write lock at the start of a unit of work, so two
  writers cannot both read a balance and only discover the conflict at commit.
* A compare-and-swap on the budget row's snapshot hash catches the writer that slipped
  in *before* the transaction opened — which is the normal shape here, since admission
  and approval happen well before the reservation.

Every artifact is stored as the canonical payload it already hashes for its identity,
alongside that hash. Reads re-compute the hash and rebuild the artifact through its own
constructor, so a record that was altered, or that no longer satisfies the domain
rules, is refused rather than returned in a weaker form.

Scope, stated plainly:

> **Single-database transactional safety: implemented.**
> **Multi-node distributed coordination: not implemented.**

One SQLite file on one machine. There is no distributed lock, no replication and no
encryption at rest — SQLite does not provide it and nothing here adds a home-made
substitute.
"""
from __future__ import annotations

from .connection import Clock, FixedClock, connect, initialize, migrate, open_existing, verify_schema
from .errors import (
    AppendOnlyViolationError,
    ConcurrentBudgetModificationError,
    CorruptRecordError,
    PersistenceError,
    RecordNotFoundError,
    SchemaVersionMismatchError,
    TransactionError,
)
from .schema import (
    APPEND_ONLY_TABLES,
    CANONICAL_SERIALIZATION_VERSION,
    PRAGMAS,
    SCHEMA_VERSION,
)
from .service import RESERVE_OPERATION, BudgetService
from .store import GovernanceStore, GovernanceUnitOfWork

__all__ = [
    "GovernanceStore", "GovernanceUnitOfWork", "BudgetService", "RESERVE_OPERATION",
    "Clock", "FixedClock",
    "connect", "initialize", "migrate", "open_existing", "verify_schema",
    "SCHEMA_VERSION", "CANONICAL_SERIALIZATION_VERSION", "APPEND_ONLY_TABLES",
    "PRAGMAS",
    "PersistenceError", "SchemaVersionMismatchError", "CorruptRecordError",
    "RecordNotFoundError", "ConcurrentBudgetModificationError",
    "AppendOnlyViolationError", "TransactionError",
]
