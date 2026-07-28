"""Append-only decision store.

An approval record is evidence. Evidence that can be edited is not evidence, so there
is no update path here: changing your mind produces a *new* record that supersedes the
old one, and both remain readable. The §2 apparatus minted a separate execution grant
for the same reason — an authorisation you can quietly widen after the fact authorises
nothing.

In-memory and product-owned. P1c is not authorised to add persistence; what matters
for review is the semantics, and a durable implementation slots in behind the same
surface.
"""
from __future__ import annotations

from typing import Iterable, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..contracts.approval import ApprovalDecision, ApprovalRequest, ApprovalStatus
from .errors import DecisionAlreadyRecordedError, UnknownApprovalRequestError


class ApprovalLog(BaseModel):
    """Every request and every decision, in the order they happened.

    Immutable: each operation returns a new log. Supersession is modelled as a new
    record whose status is ``SUPERSEDED`` on the old one — the old decision is never
    deleted, so "what were we authorised to do last Tuesday" stays answerable.
    """

    model_config = ConfigDict(frozen=True)

    requests: list[ApprovalRequest] = Field(default_factory=list)
    decisions: list[ApprovalDecision] = Field(default_factory=list)

    # --- reads ---
    def request(self, request_id: str) -> ApprovalRequest:
        for r in self.requests:
            if r.request_id == request_id:
                return r
        raise UnknownApprovalRequestError(request_id)

    def decisions_for(self, plan_id: str) -> list[ApprovalDecision]:
        return [d for d in self.decisions if d.plan_id == plan_id]

    def decision(self, decision_id: str) -> Optional[ApprovalDecision]:
        for d in self.decisions:
            if d.decision_id == decision_id:
                return d
        return None

    def latest_for(self, plan_id: str) -> Optional[ApprovalDecision]:
        found = self.decisions_for(plan_id)
        return found[-1] if found else None

    def effective_for(self, plan_id: str, *, now: Optional[str] = None
                      ) -> Optional[ApprovalDecision]:
        """The most recent decision still in force, if any.

        Walks backwards so a later revocation or supersession wins over an earlier
        approval, which is the order a reader would expect and the order that is safe.
        """
        for decision in reversed(self.decisions_for(plan_id)):
            if decision.status is ApprovalStatus.APPROVED:
                try:
                    if decision.is_effective(now=now):
                        return decision
                except ValueError:
                    # Expiring decision with no clock supplied: cannot be relied on.
                    return None
                return None
            if decision.status in (ApprovalStatus.REVOKED, ApprovalStatus.SUPERSEDED,
                                   ApprovalStatus.REJECTED, ApprovalStatus.EXPIRED):
                return None
        return None

    # --- appends ---
    def with_request(self, request: ApprovalRequest) -> "ApprovalLog":
        if any(r.request_id == request.request_id for r in self.requests):
            raise ValueError(f"request {request.request_id!r} already recorded")
        return self.model_copy(update={"requests": [*self.requests, request]})

    def with_decision(self, decision: ApprovalDecision) -> "ApprovalLog":
        if self.decision(decision.decision_id) is not None:
            raise DecisionAlreadyRecordedError(decision.decision_id)
        return self.model_copy(update={"decisions": [*self.decisions, decision]})

    def with_superseded(self, plan_id: str, *, reason: str, at: str,
                        by: str) -> "ApprovalLog":
        """Mark every live approval for a plan as superseded, by appending records.

        Nothing is mutated. Each live decision gains a successor whose status is
        ``SUPERSEDED``, so the history reads as a sequence of facts rather than a
        redacted one.
        """
        successors: list[ApprovalDecision] = []
        for decision in self.decisions_for(plan_id):
            if decision.status is not ApprovalStatus.APPROVED:
                continue
            successors.append(decision.model_copy(update={
                "decision_id": f"{decision.decision_id}::superseded",
                "status": ApprovalStatus.SUPERSEDED,
                "reason": reason,
                "decided_at": at,
                "approved_by": by,
            }))
        if not successors:
            return self
        return self.model_copy(update={"decisions": [*self.decisions, *successors]})

    def all_decisions(self) -> Iterable[ApprovalDecision]:
        return tuple(self.decisions)
