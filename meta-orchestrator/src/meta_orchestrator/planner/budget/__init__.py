"""Budget admission (P1c) — may this cost be incurred?

Asked before money moves, never after. Three rules the package exists to hold:

* measured against ``committed + actual``, so two calls in flight cannot each see room
  only one of them has;
* a non-authoritative price cannot back a real budget — fictional rates produce clean
  arithmetic and a meaningless answer;
* contingency is a separate, visible addend (``quoted + reserve``), never a padded
  rate. That was G2, and :mod:`.reserve` exists so it cannot return through this door.

Decides only. Does not execute, does not spend, and is not wired to the orchestrator.
"""
from __future__ import annotations

from .errors import (
    BudgetGuardError,
    DoubleReconcileError,
    InsufficientBudgetError,
    NonAuthoritativePriceError,
    UnknownReservationError,
)
from .guard import AdmissionReport, BudgetGuard
from .ledger import Reservation, ReservationLedger, ReservationStatus
from .reserve import ReserveBasis, ReservedAmount, ReservePolicy, apply_reserve

__all__ = [
    "BudgetGuard", "AdmissionReport",
    "ReservationLedger", "Reservation", "ReservationStatus",
    "ReservePolicy", "ReserveBasis", "ReservedAmount", "apply_reserve",
    "BudgetGuardError", "InsufficientBudgetError", "NonAuthoritativePriceError",
    "UnknownReservationError", "DoubleReconcileError",
]
