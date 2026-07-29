"""Storage ports. The domain never imports SQLite; SQLite implements these.

Every read returns a **rebuilt domain artifact**, not a row and not a dict. That is the
boundary: persistence may decide how something is stored, and may not decide what it
means. A record that will not rebuild into a valid artifact is refused rather than
handed back in a weaker form.

``GovernanceUnitOfWork`` is where the atomicity lives. Nothing that changes a budget is
available outside one, because "reserve" and "update the balance" are the same act and
splitting them is precisely the failure this layer exists to prevent.
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from ..governance.authorization import ExecutionAuthorization
from ..governance.events import GovernanceEvent
from ..governance.override import BudgetOverride
from ..governance.reservation import SettlementResult, SpendReservation
from ..governance.snapshots import BudgetSnapshot, PlanSnapshot


@runtime_checkable
class BudgetSnapshotStore(Protocol):
    def put(self, snapshot: BudgetSnapshot) -> None: ...
    def get(self, content_hash: str) -> BudgetSnapshot: ...
    def current(self, budget_id: str) -> BudgetSnapshot: ...
    def history(self, budget_id: str) -> list[BudgetSnapshot]: ...


@runtime_checkable
class PlanSnapshotStore(Protocol):
    def put(self, snapshot: PlanSnapshot) -> None: ...
    def get(self, content_hash: str) -> PlanSnapshot: ...


@runtime_checkable
class ApprovalStore(Protocol):
    """Append-only. A superseded decision is a new record, never an edit."""

    def put_request(self, request) -> None: ...
    def put_decision(self, decision) -> None: ...
    def get_decision(self, decision_id: str): ...
    def decisions_for_request(self, request_id: str) -> list: ...


@runtime_checkable
class AuthorizationStore(Protocol):
    def put(self, authorization: ExecutionAuthorization) -> None: ...
    def get(self, authorization_id: str) -> ExecutionAuthorization: ...
    def for_plan(self, plan_id: str) -> list[ExecutionAuthorization]: ...


@runtime_checkable
class ReservationStore(Protocol):
    """The one artifact whose status advances. Every step is also appended to history."""

    def put(self, reservation: SpendReservation) -> None: ...
    def advance(self, reservation: SpendReservation) -> None: ...
    def get(self, reservation_id: str) -> SpendReservation: ...
    def by_idempotency_key(self, budget_id: str,
                           key: str) -> Optional[SpendReservation]: ...
    def open_for_budget(self, budget_id: str) -> list[SpendReservation]: ...
    def history(self, reservation_id: str) -> list[SpendReservation]: ...


@runtime_checkable
class SettlementStore(Protocol):
    def put(self, result: SettlementResult) -> None: ...
    def get(self, reservation_id: str) -> SettlementResult: ...
    def requiring_review(self) -> list[SettlementResult]: ...


@runtime_checkable
class OverrideStore(Protocol):
    def put(self, override: BudgetOverride, *, budget_id: str) -> None: ...
    def get(self, override_id: str) -> BudgetOverride: ...
    def for_budget(self, budget_id: str) -> list[BudgetOverride]: ...


@runtime_checkable
class GovernanceEventStore(Protocol):
    def append(self, event: GovernanceEvent) -> None: ...
    def for_plan(self, plan_id: str) -> list[GovernanceEvent]: ...
    def for_budget(self, budget_id: str) -> list[GovernanceEvent]: ...
    def all(self) -> list[GovernanceEvent]: ...


@runtime_checkable
class IdempotencyStore(Protocol):
    """Persistent, because an in-memory map forgets exactly when it matters — after
    the restart that followed the ambiguous call."""

    def record(self, *, key: str, operation: str, request_hash: str,
               entity_id: str, entity_hash: str) -> None: ...
    def lookup(self, *, key: str,
               operation: str) -> Optional[tuple[str, str, str]]: ...


@runtime_checkable
class GovernanceUnitOfWork(Protocol):
    """One transaction, holding the write lock from the start.

    Entered with ``with``: committing on a clean exit, rolling back on any exception.
    The stores it exposes are the same objects used outside a transaction — the
    difference is that inside one, their writes are atomic together.
    """

    budgets: BudgetSnapshotStore
    plans: PlanSnapshotStore
    approvals: ApprovalStore
    authorizations: AuthorizationStore
    reservations: ReservationStore
    settlements: SettlementStore
    overrides: OverrideStore
    events: GovernanceEventStore
    idempotency: IdempotencyStore

    def __enter__(self) -> "GovernanceUnitOfWork": ...
    def __exit__(self, exc_type, exc, tb) -> None: ...

    def compare_and_swap_budget(self, *, budget_id: str, expected_hash: str,
                                new_snapshot: BudgetSnapshot) -> None:
        """Advance the budget only if it is still where the caller last saw it.

        Zero affected rows means another writer moved first, and the whole transaction
        is abandoned rather than committing against a balance that has changed.
        """
        ...
