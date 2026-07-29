"""Autonomy modes (SPEC §10, D1).

Like Claude Code's auto mode: the orchestrator proceeds on its own until the user
steps in. Modes are switchable mid-run (the controller holds a mutable mode read at
each gate):

- full-auto        : run everything (incl. paid actions) up to the budget ceiling.
- ask-on-expensive : pause for approval before an action whose est. cost exceeds a threshold.
- plan-first       : present the plan + est. cost and wait for approval before executing.

The hard budget/round ceiling (BudgetLedger) is always enforced regardless of mode.
"""
from __future__ import annotations

from enum import Enum
from typing import Callable, Optional

Approver = Callable[[str, dict], bool]


class AutonomyMode(str, Enum):
    FULL_AUTO = "full-auto"
    ASK_ON_EXPENSIVE = "ask-on-expensive"
    PLAN_FIRST = "plan-first"


class AutonomyController:
    def __init__(self, mode: str | AutonomyMode = AutonomyMode.FULL_AUTO,
                 expensive_cost_threshold: float = 0.01) -> None:
        self.mode = AutonomyMode(mode)
        self.expensive_cost_threshold = expensive_cost_threshold

    def set_mode(self, mode: str | AutonomyMode) -> None:
        """Switch mode — may be called mid-run; the next gate observes the new mode."""
        self.mode = AutonomyMode(mode)

    def gate(self, *, est_cost: float, approver: Optional[Approver]) -> tuple[bool, str]:
        """Decide whether to proceed past the pre-execution gate."""
        if self.mode is AutonomyMode.FULL_AUTO:
            return True, "full-auto"
        if self.mode is AutonomyMode.PLAN_FIRST:
            ok = bool(approver and approver("plan", {"est_cost": est_cost}))
            return ok, "plan-first:approved" if ok else "plan-first:not-approved"
        # ASK_ON_EXPENSIVE
        if est_cost <= self.expensive_cost_threshold:
            return True, f"cheap (est_cost={est_cost:.4f} <= {self.expensive_cost_threshold})"
        ok = bool(approver and approver("expensive_action", {"est_cost": est_cost}))
        return ok, "expensive:approved" if ok else "expensive:not-approved"
