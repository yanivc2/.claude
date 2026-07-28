"""Planner error contracts.

Every one of these is fail-closed: they are raised to *prevent* an action, never to
report that one already happened. They inherit from :class:`PlannerError` so a caller
can catch the whole family, and each carries the identifiers needed to act on it
rather than only a message.
"""
from __future__ import annotations


class PlannerError(Exception):
    """Base for every Planner-raised failure."""


class IllegalTransitionError(PlannerError):
    """A plan lifecycle move that the transition table forbids.

    Notably raised for ``AWAITING_APPROVAL -> EXECUTING``: skipping ``APPROVED`` is
    the one shortcut that would let work start without a recorded decision.
    """

    def __init__(self, src: str, dst: str) -> None:
        self.src, self.dst = src, dst
        super().__init__(f"illegal plan transition: {src} -> {dst}")


class ApprovalRequiredError(PlannerError):
    """Execution was attempted without an approval decision that covers it."""

    def __init__(self, plan_id: str, detail: str) -> None:
        self.plan_id, self.detail = plan_id, detail
        super().__init__(f"plan {plan_id!r} may not execute: {detail}")


class BudgetExceededError(PlannerError):
    """The projected spend would cross the hard cap. Raised before sending, not after."""

    def __init__(self, plan_id: str, detail: str) -> None:
        self.plan_id, self.detail = plan_id, detail
        super().__init__(f"plan {plan_id!r} blocked on budget: {detail}")


class ScopeIncompleteError(PlannerError):
    """An estimate was requested while blocking clarifying questions are outstanding."""

    def __init__(self, scope_id: str, question_ids: list[str]) -> None:
        self.scope_id, self.question_ids = scope_id, question_ids
        super().__init__(
            f"scope {scope_id!r} cannot be estimated — unanswered blocking questions: "
            f"{question_ids}")


class ObservabilityIncompleteError(PlannerError):
    """Mandatory raw evidence is missing.

    The §2 closeout made this non-negotiable after a Gate-A failure could not be
    localised post hoc. Blocking here is cheaper than repeating a paid run.
    """

    def __init__(self, usage_id: str, detail: str) -> None:
        self.usage_id, self.detail = usage_id, detail
        super().__init__(f"usage {usage_id!r} is not auditable: {detail}")


class PricingDriftError(PlannerError):
    """The pricing behind an estimate no longer matches the pricing in force.

    Modelled on the §2 pricing artifact's drift guard: an estimate authorised under one
    price is not authorised under another, however small the change.
    """

    def __init__(self, expected_ref: str, actual_ref: str) -> None:
        self.expected_ref, self.actual_ref = expected_ref, actual_ref
        super().__init__(
            f"pricing drift: estimate was made under {expected_ref!r}, "
            f"now {actual_ref!r} — re-estimate and re-approve")
