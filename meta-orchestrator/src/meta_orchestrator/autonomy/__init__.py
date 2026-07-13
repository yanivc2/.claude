"""Autonomy + budget (SPEC §10). Phase 1: the budget ledger / circuit breaker.

Full autonomy modes (full-auto / ask-on-expensive / plan-first) land in Milestone D.
"""
from .budget import BudgetExhaustedError, BudgetLedger

__all__ = ["BudgetLedger", "BudgetExhaustedError"]
