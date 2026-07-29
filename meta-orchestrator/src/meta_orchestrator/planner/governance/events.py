"""Governance events — immutable records of what was decided and when.

Evidence, not messaging. Each event is content-hashed so a log can be checked rather
than trusted, and each carries the identities needed to reconstruct the decision
afterwards by someone who was not there.

Two deliberate omissions:

* **No persistence.** These are artifacts; storing them is a later phase.
* **No raw prompts.** An event records *that* a call was authorised and what it was
  bounded by, never the content that went into it. A governance log that accumulates
  prompt text becomes the largest uncontrolled data store in the system.
"""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from ..contracts.money import Money
from .canonical import CanonicalMixin
from .purpose import SpendPurpose


class GovernanceEventType(str, Enum):
    ADMISSION_EVALUATED = "admission.evaluated"
    ADMISSION_REJECTED = "admission.rejected"

    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_GRANTED = "approval.granted"
    APPROVAL_REJECTED = "approval.rejected"
    APPROVAL_EXPIRED = "approval.expired"
    APPROVAL_REVOKED = "approval.revoked"

    AUTHORIZATION_ISSUED = "authorization.issued"
    AUTHORIZATION_REFUSED = "authorization.refused"

    RESERVATION_PROPOSED = "reservation.proposed"
    RESERVATION_COMMITTED = "reservation.committed"
    RESERVATION_RELEASED = "reservation.released"
    RESERVATION_SETTLED = "reservation.settled"
    RESERVATION_MARKED_AMBIGUOUS = "reservation.marked_ambiguous"
    OVERRUN_DETECTED = "overrun.detected"

    OVERRIDE_REQUESTED = "override.requested"
    OVERRIDE_APPROVED = "override.approved"
    OVERRIDE_REJECTED = "override.rejected"


class GovernanceEvent(BaseModel, CanonicalMixin):
    """One recorded governance fact.

    ``subject_hashes`` carries the identities the event refers to — plan, snapshot,
    admission, authorization — so the event can be joined to the artifacts it
    describes without embedding them.
    """

    model_config = ConfigDict(frozen=True)

    event_type: GovernanceEventType
    occurred_at: str
    purpose: SpendPurpose
    plan_id: str = ""
    budget_id: str = ""
    actor: str = ""
    #: Named identities, e.g. {"plan_hash": "...", "budget_snapshot_hash": "..."}.
    subject_hashes: dict[str, str] = Field(default_factory=dict)
    amount: Optional[Money] = None
    #: Condition codes relevant to this event — why it was refused, what was warned.
    condition_codes: list[str] = Field(default_factory=list)
    detail: str = ""
    markers: list[str] = Field(default_factory=list)

    def canonical_payload(self) -> dict:
        return {
            "event_type": self.event_type.value,
            "occurred_at": self.occurred_at,
            "purpose": self.purpose.value,
            "plan_id": self.plan_id,
            "budget_id": self.budget_id,
            "actor": self.actor,
            "subject_hashes": dict(sorted(self.subject_hashes.items())),
            "amount": self.amount,
            "condition_codes": sorted(self.condition_codes),
            "detail": self.detail,
            "markers": sorted(self.markers),
        }


class GovernanceEventLog(BaseModel):
    """An append-only sequence of events. Immutable; no storage."""

    model_config = ConfigDict(frozen=True)

    events: list[GovernanceEvent] = Field(default_factory=list)

    def append(self, event: GovernanceEvent) -> "GovernanceEventLog":
        return self.model_copy(update={"events": [*self.events, event]})

    def of_type(self, event_type: GovernanceEventType) -> list[GovernanceEvent]:
        return [e for e in self.events if e.event_type is event_type]

    def for_plan(self, plan_id: str) -> list[GovernanceEvent]:
        return [e for e in self.events if e.plan_id == plan_id]

    def content_hash(self) -> str:
        """Identity of the whole log — changes if any event is added or altered."""
        from .canonical import content_hash as _hash

        return _hash({"events": [e.canonical_payload() for e in self.events]})
