"""Approval errors. All fail-closed: no record means no permission."""
from __future__ import annotations

from ..contracts.errors import PlannerError


class ApprovalGateError(PlannerError):
    """Base for approval-gate failures."""


class UnknownApprovalRequestError(ApprovalGateError):
    """A decision references a request that was never presented."""

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        super().__init__(f"unknown approval request {request_id!r}")


class DecisionAlreadyRecordedError(ApprovalGateError):
    """An approval record is append-only; the same id cannot be written twice.

    A changed mind is a new record that supersedes the old one. Overwriting would
    destroy the answer to "what were we authorised to do at the time".
    """

    def __init__(self, decision_id: str) -> None:
        self.decision_id = decision_id
        super().__init__(
            f"decision {decision_id!r} is already recorded — records are append-only")


class DecisionMismatchError(ApprovalGateError):
    """A decision does not describe the request it claims to answer."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"approval decision does not match its request: {detail}")
