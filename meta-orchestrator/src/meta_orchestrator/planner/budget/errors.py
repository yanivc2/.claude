"""Budget errors. Every one blocks an action before it happens."""
from __future__ import annotations

from ..contracts.errors import PlannerError


class BudgetGuardError(PlannerError):
    """Base for budget-admission failures."""


class InsufficientBudgetError(BudgetGuardError):
    """Reserving would push the encumbered total past the cap. Raised before spending."""

    def __init__(self, plan_id: str, detail: str) -> None:
        self.plan_id, self.detail = plan_id, detail
        super().__init__(f"plan {plan_id!r}: {detail}")


class NonAuthoritativePriceError(BudgetGuardError):
    """A real budget was checked against a price that may not back one.

    Fictional, test-only and unverified prices produce perfectly good arithmetic and
    a meaningless answer. Admitting on one would be the worst kind of pass: numerically
    clean, and wrong about the only thing that mattered.
    """

    def __init__(self, model_id: str, trust: str) -> None:
        self.model_id, self.trust = model_id, trust
        super().__init__(
            f"price for {model_id!r} is {trust}: it cannot back a real budget")


class UnknownReservationError(BudgetGuardError):
    """No reservation with that id exists in the ledger."""

    def __init__(self, reservation_id: str) -> None:
        self.reservation_id = reservation_id
        super().__init__(f"unknown reservation {reservation_id!r}")


class DoubleReconcileError(BudgetGuardError):
    """A reservation was settled twice, or settled from the wrong state."""

    def __init__(self, reservation_id: str, status: str) -> None:
        self.reservation_id, self.status = reservation_id, status
        super().__init__(
            f"reservation {reservation_id!r} is already {status} — refusing to settle "
            "it again")
