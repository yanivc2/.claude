"""A hard, explicit budget for the pilot (P2m §8).

Small and auditable on purpose: it proves, before any call, that the pilot cannot
exceed a stated cost or a stated number of calls. The token-counting endpoint is not a
generation call and is not expected to bill, but the pilot does not *assume* free — it
counts calls and refuses to go past the ceiling either way.
"""
from __future__ import annotations

from decimal import Decimal

from ..contracts.money import Money
from .errors import PilotBudgetExhaustedError

#: The pilot's hard ceiling, per the P2m GO.
DEFAULT_PILOT_CAP = Money(amount=Decimal("1.00"))
DEFAULT_MAX_CALLS = 30


class PilotBudget:
    """Tracks calls and cost against a hard cap. Fail-closed: charge *before* the call.

    ``per_call_cost`` defaults to zero because token counting is not billed as
    inference, but the ceiling is enforced regardless of that assumption — if a cost is
    ever supplied, the same cap stops the run.
    """

    def __init__(self, cap: Money = DEFAULT_PILOT_CAP, max_calls: int = DEFAULT_MAX_CALLS,
                 per_call_cost: Money = Money(amount=Decimal("0"))) -> None:
        if cap.amount < 0:
            raise ValueError("pilot cap cannot be negative")
        if max_calls < 0:
            raise ValueError("max_calls cannot be negative")
        self._cap = cap
        self._max_calls = max_calls
        self._per_call_cost = per_call_cost
        self._spent = Money(amount=Decimal("0"), currency=cap.currency)
        self._calls = 0

    @property
    def calls_made(self) -> int:
        return self._calls

    @property
    def spent(self) -> Money:
        return self._spent

    @property
    def cap(self) -> Money:
        return self._cap

    @property
    def max_calls(self) -> int:
        return self._max_calls

    def remaining(self) -> Money:
        return self._cap - self._spent

    def authorise_call(self) -> None:
        """Reserve one call. Raises before the ceiling is crossed; sends nothing itself."""
        if self._calls + 1 > self._max_calls:
            raise PilotBudgetExhaustedError(
                f"call ceiling reached: {self._calls}/{self._max_calls} calls made")
        projected = self._spent + self._per_call_cost
        if projected > self._cap:
            raise PilotBudgetExhaustedError(
                f"cost cap would be exceeded: {projected.amount} > {self._cap.amount} "
                f"{self._cap.currency}")
        self._calls += 1
        self._spent = projected
