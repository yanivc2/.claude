"""Persistence errors. All fail-closed — a doubtful record is never returned."""
from __future__ import annotations

from ..contracts.errors import PlannerError


class PersistenceError(PlannerError):
    """Base for storage failures."""


class SchemaVersionMismatchError(PersistenceError):
    """The database was created by a different schema version.

    Refused rather than migrated on the fly: an implicit migration during an import is
    how a budget ledger gets silently rewritten by a process nobody was watching.
    """

    def __init__(self, found: str, expected: str) -> None:
        self.found, self.expected = found, expected
        super().__init__(
            f"database schema is {found!r}, this build expects {expected!r} — run the "
            "explicit migrate step; nothing is migrated implicitly")


class CorruptRecordError(PersistenceError):
    """A stored record no longer hashes to what was written with it.

    Either the payload was edited outside the application or the serialization changed
    underneath it. Both mean the record cannot be trusted, so it is not returned.
    """

    def __init__(self, table: str, entity_id: str, stored: str, computed: str) -> None:
        self.table, self.entity_id = table, entity_id
        super().__init__(
            f"{table}/{entity_id}: stored hash {stored[:16]}… does not match the "
            f"payload's {computed[:16]}… — refusing to return a record that may have "
            "been altered")


class RecordNotFoundError(PersistenceError):
    def __init__(self, table: str, entity_id: str) -> None:
        self.table, self.entity_id = table, entity_id
        super().__init__(f"no {table} record with id {entity_id!r}")


class ConcurrentBudgetModificationError(PersistenceError):
    """Another writer changed the budget between the read and the write.

    Raised when a compare-and-swap update affects zero rows: the snapshot this
    operation was built on is no longer current, so committing would spend against a
    balance that has already moved. The caller must re-read and re-decide.
    """

    def __init__(self, budget_id: str, expected_hash: str) -> None:
        self.budget_id, self.expected_hash = budget_id, expected_hash
        super().__init__(
            f"budget {budget_id!r} moved under a transaction expecting snapshot "
            f"{expected_hash[:16]}… — re-read and re-decide; nothing was written")


class AppendOnlyViolationError(PersistenceError):
    """An attempt to overwrite a record in an append-only table.

    History is the product here. A superseded approval becomes a *new* record; it does
    not get edited in place.
    """

    def __init__(self, table: str, entity_id: str) -> None:
        self.table, self.entity_id = table, entity_id
        super().__init__(
            f"{table} is append-only — {entity_id!r} already exists and cannot be "
            "rewritten; record a new entry instead")


class TransactionError(PersistenceError):
    """A unit of work was used incorrectly — nested, reused, or committed twice."""


class InjectedFaultError(PersistenceError):
    """Raised by a test fault point. Never reachable in normal operation."""
