"""Atomic budget operations. The reason P1d is not "saving files".

Each operation below is one transaction. There is no window in which a reservation
exists but the balance does not reflect it, no window in which the balance moved but
the reservation was not written, and no window in which an event describes something
that did not happen.

The sequence for every mutating operation is the same:

    BEGIN IMMEDIATE
      -> re-read the current snapshot inside the lock
      -> compare it with what the caller decided against
      -> validate in the domain
      -> write records
      -> compare-and-swap the budget row
      -> append events
    COMMIT

Steps 2 and 6 are both present on purpose. The re-read catches a caller working from a
snapshot taken minutes ago at approval time; the CAS catches anything that slipped in
between. Either one alone leaves a gap.
"""
from __future__ import annotations

from typing import Optional

from ..contracts.money import Money
from ..governance.authorization import ExecutionAuthorization
from ..governance.canonical import content_hash
from ..governance.errors import StaleSnapshotError
from ..governance.events import GovernanceEvent, GovernanceEventType
from ..governance.override import BudgetOverride, OverrideOutcome
from ..governance.purpose import SpendPurpose
from ..governance.reservation import (
    SettlementResult,
    SpendReservation,
    SpendReservationStatus,
)
from ..governance.snapshots import BudgetSnapshot
from ..governance.errors import IdempotencyConflictError
from .records import dump
from .store import GovernanceStore

RESERVE_OPERATION = "reserve"


def _advanced(snapshot: BudgetSnapshot, *, committed: Money, actual: Money,
              taken_at: str, effective_cap: Optional[Money] = None,
              override_ids: Optional[list[str]] = None) -> BudgetSnapshot:
    """The next snapshot for a budget. Version always moves, so identity always moves."""
    return BudgetSnapshot(
        budget_id=snapshot.budget_id, policy_id=snapshot.policy_id,
        policy_hash=snapshot.policy_hash, currency=snapshot.currency,
        hard_cap=snapshot.hard_cap,
        effective_cap=effective_cap or snapshot.effective_cap,
        actual_spend=actual, committed_spend=committed,
        approved_override_ids=(override_ids if override_ids is not None
                               else list(snapshot.approved_override_ids)),
        snapshot_version=snapshot.snapshot_version + 1, taken_at=taken_at,
        provider_credits=snapshot.provider_credits)


class BudgetService:
    """Transactional budget operations over a :class:`GovernanceStore`."""

    def __init__(self, store: GovernanceStore) -> None:
        self._store = store

    # ------------------------------------------------------------------ #
    # Reserve
    # ------------------------------------------------------------------ #
    def reserve(self, *, authorization: ExecutionAuthorization,
                reservation_id: str, idempotency_key: str, amount: Money,
                reserve_component: Money, expected_snapshot_hash: str,
                at: str) -> SpendReservation:
        """Hold money against a budget, atomically, or raise having written nothing.

        An identical retry returns the original reservation without holding a second
        amount — the check is persistent, so it survives the restart that so often
        follows the retry.
        """
        store = self._store
        with store.unit_of_work() as uow:
            budget_id = _budget_of(authorization)

            # Idempotency first: a repeat must not even take a lock decision on the
            # balance, and must return exactly what the first call produced.
            seen = uow.idempotency.lookup(key=idempotency_key,
                                          operation=RESERVE_OPERATION)
            request_hash = content_hash({
                "authorization_id": authorization.authorization_id,
                "budget_id": budget_id, "amount": amount,
                "reserve_component": reserve_component})
            if seen is not None:
                stored_request_hash, entity_id, _ = seen
                if stored_request_hash != request_hash:
                    raise IdempotencyConflictError(idempotency_key)
                return uow.reservations.get(entity_id)

            current = uow.budgets.current(budget_id)
            if current.content_hash() != expected_snapshot_hash:
                raise StaleSnapshotError(expected_snapshot_hash,
                                         current.content_hash())

            if current.would_exceed(amount):
                from ..budget.errors import InsufficientBudgetError

                raise InsufficientBudgetError(
                    authorization.plan_id,
                    f"reserving {amount} against {current.encumbered} would pass the "
                    f"effective cap of {current.effective_cap}")

            reservation = SpendReservation(
                reservation_id=reservation_id, idempotency_key=idempotency_key,
                authorization_id=authorization.authorization_id, budget_id=budget_id,
                plan_id=authorization.plan_id, amount=amount,
                reserve_component=reserve_component,
                currency=current.currency).commit()

            uow.reservations.put(reservation)
            uow.fault("after_reservation_insert")

            uow.compare_and_swap_budget(
                budget_id=budget_id, expected_hash=expected_snapshot_hash,
                new_snapshot=_advanced(current,
                                       committed=current.committed_spend + amount,
                                       actual=current.actual_spend, taken_at=at))
            uow.fault("after_snapshot_update")

            _, entity_hash = dump(reservation)
            uow.idempotency.record(
                key=idempotency_key, operation=RESERVE_OPERATION,
                request_hash=request_hash, entity_id=reservation_id,
                entity_hash=entity_hash)

            uow.events.append(GovernanceEvent(
                event_type=GovernanceEventType.RESERVATION_COMMITTED,
                occurred_at=at, purpose=authorization.purpose,
                plan_id=authorization.plan_id, budget_id=budget_id,
                subject_hashes={"reservation_hash": entity_hash,
                                "authorization_hash": authorization.content_hash()},
                amount=amount))
            uow.fault("after_event_append")
            return reservation

    # ------------------------------------------------------------------ #
    # Settle
    # ------------------------------------------------------------------ #
    def settle(self, *, reservation_id: str, actual: Money,
               expected_snapshot_hash: str, at: str,
               purpose: SpendPurpose = SpendPurpose.REAL_SPEND
               ) -> SettlementResult:
        """Convert a hold into real spend, atomically.

        An overrun is **not** settled here. The reservation stays open, an overrun
        event is written, and the caller is told review is required — absorbing the
        difference would be indistinguishable from having no cap.
        """
        store = self._store
        with store.unit_of_work() as uow:
            reservation = uow.reservations.get(reservation_id)
            current = uow.budgets.current(reservation.budget_id)
            if current.content_hash() != expected_snapshot_hash:
                raise StaleSnapshotError(expected_snapshot_hash,
                                         current.content_hash())

            settled = reservation.settle(actual)
            result = SettlementResult.of(settled)

            if result.review_required:
                # Leave the hold in place and record the fact. No auto-settle, no
                # auto-release, no silent cap increase.
                uow.events.append(GovernanceEvent(
                    event_type=GovernanceEventType.OVERRUN_DETECTED,
                    occurred_at=at, purpose=purpose, plan_id=reservation.plan_id,
                    budget_id=reservation.budget_id,
                    subject_hashes={"reservation_hash": reservation.content_hash()},
                    amount=result.overrun,
                    detail=("settlement exceeded the reservation; the hold stands and "
                            "the budget is unchanged pending review")))
                return result

            uow.reservations.advance(settled)
            uow.fault("after_settle_advance")

            uow.settlements.put(result)
            uow.compare_and_swap_budget(
                budget_id=reservation.budget_id,
                expected_hash=expected_snapshot_hash,
                new_snapshot=_advanced(
                    current,
                    committed=current.committed_spend - reservation.amount,
                    actual=current.actual_spend + actual, taken_at=at))

            uow.events.append(GovernanceEvent(
                event_type=GovernanceEventType.RESERVATION_SETTLED,
                occurred_at=at, purpose=purpose, plan_id=reservation.plan_id,
                budget_id=reservation.budget_id,
                subject_hashes={"reservation_hash": settled.content_hash(),
                                "settlement_hash": result.content_hash()},
                amount=actual))
            return result

    # ------------------------------------------------------------------ #
    # Release / ambiguity
    # ------------------------------------------------------------------ #
    def release(self, *, reservation_id: str, reason: str,
                expected_snapshot_hash: str, at: str,
                purpose: SpendPurpose = SpendPurpose.REAL_SPEND) -> SpendReservation:
        """Free a hold for a call that provably never reached the provider."""
        with self._store.unit_of_work() as uow:
            reservation = uow.reservations.get(reservation_id)
            current = uow.budgets.current(reservation.budget_id)
            if current.content_hash() != expected_snapshot_hash:
                raise StaleSnapshotError(expected_snapshot_hash,
                                         current.content_hash())

            released = reservation.release(reason=reason)
            uow.reservations.advance(released)
            uow.compare_and_swap_budget(
                budget_id=reservation.budget_id,
                expected_hash=expected_snapshot_hash,
                new_snapshot=_advanced(
                    current,
                    committed=current.committed_spend - reservation.amount,
                    actual=current.actual_spend, taken_at=at))
            uow.events.append(GovernanceEvent(
                event_type=GovernanceEventType.RESERVATION_RELEASED,
                occurred_at=at, purpose=purpose, plan_id=reservation.plan_id,
                budget_id=reservation.budget_id, detail=reason,
                subject_hashes={"reservation_hash": released.content_hash()},
                amount=reservation.amount))
            return released

    def mark_ambiguous(self, *, reservation_id: str, reason: str, at: str,
                       purpose: SpendPurpose = SpendPurpose.REAL_SPEND
                       ) -> SpendReservation:
        """Record that it is unknown whether the provider billed.

        The budget is **not** touched: the hold stands, because releasing money that may
        already have been spent is how the same budget gets spent twice. This survives
        restart and is never resolved automatically.
        """
        with self._store.unit_of_work() as uow:
            reservation = uow.reservations.get(reservation_id)
            ambiguous = reservation.mark_ambiguous(reason=reason)
            uow.reservations.advance(ambiguous)
            uow.events.append(GovernanceEvent(
                event_type=GovernanceEventType.RESERVATION_MARKED_AMBIGUOUS,
                occurred_at=at, purpose=purpose, plan_id=reservation.plan_id,
                budget_id=reservation.budget_id, detail=reason,
                subject_hashes={"reservation_hash": ambiguous.content_hash()},
                amount=reservation.amount))
            return ambiguous

    def resolve_ambiguous(self, *, reservation_id: str, was_billed: bool,
                          actual: Optional[Money], resolved_by: str, reason: str,
                          expected_snapshot_hash: str, at: str,
                          purpose: SpendPurpose = SpendPurpose.REAL_SPEND):
        """Human resolution of an ambiguous call. Attributed, and transactional."""
        if not resolved_by.strip():
            raise ValueError("resolving an ambiguous call must name who decided")
        if was_billed and actual is None:
            raise ValueError("a billed call must record what it cost")
        if was_billed:
            return self.settle(reservation_id=reservation_id, actual=actual,
                               expected_snapshot_hash=expected_snapshot_hash, at=at,
                               purpose=purpose)
        return self.release(reservation_id=reservation_id,
                            reason=f"resolved not billed by {resolved_by}: {reason}",
                            expected_snapshot_hash=expected_snapshot_hash, at=at,
                            purpose=purpose)

    # ------------------------------------------------------------------ #
    # Override
    # ------------------------------------------------------------------ #
    def apply_override(self, *, override: BudgetOverride, budget_id: str,
                       expected_snapshot_hash: str, at: str,
                       purpose: SpendPurpose = SpendPurpose.REAL_SPEND
                       ) -> OverrideOutcome:
        """Raise a cap and break the chain below it, in one transaction.

        The new snapshot has a different hash, so every admission, approval and
        authorization bound to the old one stops covering anything. That is the
        intended consequence, not a side effect.
        """
        with self._store.unit_of_work() as uow:
            current = uow.budgets.current(budget_id)
            if current.content_hash() != expected_snapshot_hash:
                raise StaleSnapshotError(expected_snapshot_hash,
                                         current.content_hash())
            if override.new_cap <= current.effective_cap:
                raise ValueError("an override must raise the effective cap")

            uow.overrides.put(override, budget_id=budget_id)
            raised = _advanced(
                current, committed=current.committed_spend,
                actual=current.actual_spend, taken_at=at,
                effective_cap=override.new_cap,
                override_ids=[*current.approved_override_ids, override.override_id])
            uow.compare_and_swap_budget(budget_id=budget_id,
                                        expected_hash=expected_snapshot_hash,
                                        new_snapshot=raised)
            uow.events.append(GovernanceEvent(
                event_type=GovernanceEventType.OVERRIDE_APPROVED,
                occurred_at=at, purpose=purpose, budget_id=budget_id,
                actor=override.actor, detail=override.reason,
                subject_hashes={"override_hash": override.content_hash(),
                                "budget_snapshot_hash": raised.content_hash()},
                amount=override.additional_amount))
            return OverrideOutcome(override=override,
                                   new_snapshot_hash=raised.content_hash())


def _budget_of(authorization: ExecutionAuthorization) -> str:
    """The budget an authorization draws on.

    Read off the artifact itself. An earlier draft kept this in a module-level map,
    which is exactly the defect this phase exists to remove: a mapping outside the
    record does not survive a restart, so after one the reservation would not know
    which balance it was drawing against.
    """
    if not authorization.budget_id:
        raise ValueError(
            f"authorization {authorization.authorization_id!r} names no budget — it "
            "cannot be used to reserve against one")
    return authorization.budget_id
