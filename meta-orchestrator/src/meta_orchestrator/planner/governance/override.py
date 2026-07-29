"""Budget override — raising a cap, on the record, and starting the chain again.

An override is not a bypass. It raises the ceiling and then **invalidates everything
downstream**: the budget snapshot changes, so the admission it was made against no
longer applies, so the approval bound to that admission no longer applies, so the
authorization issued under that approval no longer applies. Every one of those must be
redone.

That cascade is the whole design. The alternative — a flag that lets an existing
authorization spend more — is indistinguishable from having no cap, because the
override becomes the routine way past it.

There is no unlimited override. Every one names an actor, a reason, a new ceiling and
an expiry, and binds to the specific plan and admission it was granted for.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, model_validator

from ..contracts.money import Money
from .canonical import CanonicalMixin


class BudgetOverride(BaseModel, CanonicalMixin):
    """An audited decision to raise a cap for one specific plan."""

    model_config = ConfigDict(frozen=True)

    override_id: str
    actor: str
    reason: str
    business_value: str = ""

    original_cap: Money
    new_cap: Money
    currency: str

    #: Bound tightly: an override is not a general licence.
    bound_plan_hash: str
    bound_admission_hash: str
    #: The approval that authorised the override itself.
    approval_decision_id: str

    granted_at: str
    expires_at: Optional[str] = None

    @model_validator(mode="after")
    def _accountable(self) -> "BudgetOverride":
        if not self.actor.strip():
            raise ValueError("an override must name who granted it")
        if not self.reason.strip():
            raise ValueError("an override must record why it was needed")
        if not self.approval_decision_id.strip():
            raise ValueError(
                "an override is itself a decision and must cite its approval record")
        for name in ("original_cap", "new_cap"):
            if getattr(self, name).currency != self.currency:
                raise ValueError(f"{name} must be in the override's currency")
        if self.new_cap <= self.original_cap:
            raise ValueError(
                "an override must raise the ceiling — use a new policy to lower it")
        for field in ("bound_plan_hash", "bound_admission_hash"):
            value = getattr(self, field)
            if len(value) != 64:
                raise ValueError(
                    f"BudgetOverride.{field} must be a full 64-hex SHA-256 — an "
                    "override bound to a display hash is bound to nothing")
        if self.expires_at is not None and self.expires_at <= self.granted_at:
            raise ValueError("expires_at must be after granted_at")
        return self

    @property
    def additional_amount(self) -> Money:
        return self.new_cap - self.original_cap

    def is_valid_at(self, now: str) -> bool:
        if now < self.granted_at:
            return False
        return self.expires_at is None or now < self.expires_at

    def applies_to(self, *, plan_hash: str, admission_hash: str) -> bool:
        return (self.bound_plan_hash == plan_hash
                and self.bound_admission_hash == admission_hash)

    def canonical_payload(self) -> dict:
        return {
            "override_id": self.override_id,
            "actor": self.actor,
            "reason": self.reason,
            "business_value": self.business_value,
            "original_cap": self.original_cap,
            "new_cap": self.new_cap,
            "currency": self.currency,
            "bound_plan_hash": self.bound_plan_hash,
            "bound_admission_hash": self.bound_admission_hash,
            "approval_decision_id": self.approval_decision_id,
            "granted_at": self.granted_at,
            "expires_at": self.expires_at,
        }


class OverrideOutcome(BaseModel):
    """What an override invalidates. Returned so the cascade is impossible to miss."""

    model_config = ConfigDict(frozen=True)

    override: BudgetOverride
    #: The snapshot to work from now. Its hash differs, which is what breaks the chain.
    new_snapshot_hash: str
    requires_new_admission: bool = True
    requires_new_approval_request: bool = True
    requires_new_approval_decision: bool = True
    requires_new_authorization: bool = True
    note: str = (
        "the previous authorization is void: the budget snapshot changed, so the "
        "admission, approval and authorization bound to it no longer describe this run"
    )

    @model_validator(mode="after")
    def _cascade_is_not_optional(self) -> "OverrideOutcome":
        if not all((self.requires_new_admission, self.requires_new_approval_request,
                    self.requires_new_approval_decision,
                    self.requires_new_authorization)):
            raise ValueError(
                "every step downstream of an override must be redone — a partial "
                "cascade is how an override becomes a bypass")
        return self
