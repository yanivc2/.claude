"""The bundle of identities an approval is granted against.

An approval is never "yes, up to $50". It is "yes, to *this* plan, at *this* version,
estimated by *this* ruleset, priced from *this* card, under *this* policy, against
*this* budget position, for *this* purpose". Any one of those changing means the
approval no longer describes what is about to happen.

``ApprovalBinding`` collects them into one hashable artifact so the check is a single
comparison rather than a checklist somebody might shorten. ``diff`` names the field
that moved, because "the approval no longer applies" is not an actionable message.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, model_validator

from ..contracts.plan import ExecutionMode
from .canonical import CanonicalMixin
from .errors import BindingMismatchError
from .purpose import SpendPurpose

#: The fields compared, in the order a reader would want them reported.
BOUND_FIELDS = (
    "plan_hash", "plan_version", "estimate_audit_hash", "estimator_version",
    "ruleset_version", "projection_hash", "price_card_id", "price_card_content_hash",
    "pricing_catalog_version", "budget_policy_hash", "budget_snapshot_hash",
    "admission_hash", "purpose", "execution_mode", "reserve_policy_hash",
)


class ApprovalBinding(BaseModel, CanonicalMixin):
    """Everything an approval is tied to."""

    model_config = ConfigDict(frozen=True)

    plan_hash: str
    plan_version: int
    estimate_audit_hash: str
    estimator_version: str
    ruleset_version: str
    projection_hash: str
    price_card_id: str
    price_card_content_hash: str
    pricing_catalog_version: str
    budget_policy_hash: str
    budget_snapshot_hash: str
    admission_hash: str
    purpose: SpendPurpose
    execution_mode: ExecutionMode
    reserve_policy_hash: str
    #: What was actually authorised to be spent — quote plus reserve.
    approved_commitment: Optional[str] = None

    @model_validator(mode="after")
    def _fully_populated(self) -> "ApprovalBinding":
        for field in ("plan_hash", "estimate_audit_hash", "projection_hash",
                      "price_card_content_hash", "budget_snapshot_hash",
                      "admission_hash", "reserve_policy_hash"):
            value = getattr(self, field)
            if not value or not str(value).strip():
                raise ValueError(
                    f"ApprovalBinding.{field} is empty — an approval that does not name "
                    "what it was granted against binds nothing")
        for field in ("plan_hash", "estimate_audit_hash", "projection_hash",
                      "price_card_content_hash", "budget_snapshot_hash",
                      "admission_hash"):
            value = getattr(self, field)
            if len(value) != 64:
                raise ValueError(
                    f"ApprovalBinding.{field} must be a full 64-hex SHA-256, got "
                    f"{len(value)} characters — a display hash cannot bind")
        return self

    def canonical_payload(self) -> dict:
        payload = {f: getattr(self, f) for f in BOUND_FIELDS}
        payload["purpose"] = self.purpose.value
        payload["execution_mode"] = self.execution_mode.value
        payload["approved_commitment"] = self.approved_commitment
        return payload

    def diff(self, other: "ApprovalBinding") -> list[str]:
        """Which bound fields differ. Empty means the approval still applies."""
        return [f for f in BOUND_FIELDS if getattr(self, f) != getattr(other, f)]

    def assert_covers(self, current: "ApprovalBinding") -> None:
        """Raise naming the first field that moved."""
        changed = self.diff(current)
        if changed:
            field = changed[0]
            raise BindingMismatchError(field, str(getattr(self, field)),
                                       str(getattr(current, field)))
