"""ExecutionAuthorization — the artifact that permits one specific run.

Returning a decision id from ``authorise()`` was not enough. A decision says a person
said yes; an authorization says *what* they said yes to, in terms an executor can be
held to: which model, which mode, how many retries, how much may be spent, until when,
and under which stop conditions. Everything an executor is allowed to do is written
down, and nothing beyond it is permitted.

§2 drew the same line. Its Gate-1 anchor proved the design was fundable; a separately
minted execution grant permitted one scoped block of calls. One artifact doing both
jobs is how spend starts by accident.

**A content hash is not a signature.** It proves the artifact has not changed since it
was hashed. It proves nothing about who created it, and this module performs no
cryptographic authentication of any kind.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts.money import Money
from ..contracts.plan import ExecutionMode, StopCondition
from .binding import ApprovalBinding
from .canonical import CanonicalMixin
from .conditions import Acknowledgement
from .errors import PurposeMismatchError
from .purpose import NOT_ELIGIBLE_MARKER, SpendPurpose, assert_not_promotable

#: Stated in the artifact itself so nobody has to go looking for the caveat.
HASH_IS_NOT_A_SIGNATURE = (
    "content_hash proves this artifact is unmodified since hashing; it is NOT a "
    "cryptographic signature and attests nothing about who issued it"
)


class UsageCeiling(BaseModel, CanonicalMixin):
    """The hard limits an executor may not exceed under this authorization."""

    model_config = ConfigDict(frozen=True)

    max_calls: Optional[int] = None
    max_input_tokens: Optional[int] = None
    max_output_tokens: Optional[int] = None
    max_retries: Optional[int] = None
    max_verification_rounds: Optional[int] = None

    @model_validator(mode="after")
    def _non_negative(self) -> "UsageCeiling":
        for field in ("max_calls", "max_input_tokens", "max_output_tokens",
                      "max_retries", "max_verification_rounds"):
            value = getattr(self, field)
            if value is not None and value < 0:
                raise ValueError(f"UsageCeiling.{field} cannot be negative")
        return self

    @property
    def is_unbounded(self) -> bool:
        """True when nothing at all is capped — never valid for real spend."""
        return all(getattr(self, f) is None for f in
                   ("max_calls", "max_input_tokens", "max_output_tokens",
                    "max_retries", "max_verification_rounds"))

    def canonical_payload(self) -> dict:
        return {"max_calls": self.max_calls,
                "max_input_tokens": self.max_input_tokens,
                "max_output_tokens": self.max_output_tokens,
                "max_retries": self.max_retries,
                "max_verification_rounds": self.max_verification_rounds}


class ExecutionAuthorization(BaseModel, CanonicalMixin):
    """Immutable permission for one run, scoped in every dimension that matters."""

    model_config = ConfigDict(frozen=True)

    authorization_id: str
    purpose: SpendPurpose
    binding: ApprovalBinding

    #: Identities, carried directly so the artifact reads standalone.
    plan_id: str
    plan_version: int
    approval_decision_id: str
    admission_id: str
    budget_snapshot_hash: str
    #: The budget this authorization draws on. Carried on the artifact rather than in
    #: a lookup table: a mapping held outside the record does not survive the restart
    #: that P1d exists to survive.
    budget_id: str = ""

    #: What may be spent: the quote plus its explicit reserve.
    approved_commitment: Money
    reserve_amount: Money
    currency: str

    permitted_provider: str
    permitted_model_id: str
    permitted_mode: ExecutionMode
    usage_ceiling: UsageCeiling
    stop_conditions: list[StopCondition] = Field(default_factory=list)

    valid_from: str
    expires_at: Optional[str] = None
    acknowledgements: list[Acknowledgement] = Field(default_factory=list)
    markers: list[str] = Field(default_factory=list)
    issued_by: str = ""
    note: str = HASH_IS_NOT_A_SIGNATURE

    @model_validator(mode="after")
    def _coherent(self) -> "ExecutionAuthorization":
        if self.approved_commitment.currency != self.currency:
            raise ValueError("approved_commitment must be in the authorization currency")
        if self.reserve_amount.currency != self.currency:
            raise ValueError("reserve_amount must be in the authorization currency")
        if self.approved_commitment.is_negative() or self.reserve_amount.is_negative():
            raise ValueError("an authorization cannot carry a negative amount")
        if self.binding.purpose is not self.purpose:
            raise ValueError("the binding's purpose must match the authorization's")
        if self.binding.execution_mode is not self.permitted_mode:
            raise ValueError("the binding's mode must match the permitted mode")
        if self.expires_at is not None and self.expires_at <= self.valid_from:
            raise ValueError("expires_at must be after valid_from")
        if self.purpose.is_real:
            if NOT_ELIGIBLE_MARKER in self.markers:
                raise ValueError(
                    "a real-spend authorization cannot carry the simulation marker")
            if self.usage_ceiling.is_unbounded:
                raise ValueError(
                    "a real-spend authorization needs at least one usage ceiling — "
                    "unlimited permission is not permission, it is an accident waiting")
        elif NOT_ELIGIBLE_MARKER not in self.markers:
            raise ValueError(
                f"a simulation authorization must be marked {NOT_ELIGIBLE_MARKER}")
        return self

    def is_valid_at(self, now: str) -> bool:
        if now < self.valid_from:
            return False
        return self.expires_at is None or now < self.expires_at

    def assert_usable_for(self, purpose: SpendPurpose, *, now: str) -> None:
        """Raise unless this authorization permits ``purpose`` right now.

        A real-spend request against a simulation authorization is refused outright —
        the checks that were relaxed cannot be performed retroactively by relabelling.
        """
        assert_not_promotable(self.purpose, purpose)
        if not self.is_valid_at(now):
            raise PurposeMismatchError(
                f"authorization {self.authorization_id!r} is not valid at {now} "
                f"(valid_from={self.valid_from}, expires_at={self.expires_at})")

    def canonical_payload(self) -> dict:
        return {
            "authorization_id": self.authorization_id,
            "purpose": self.purpose.value,
            "binding": self.binding.canonical_payload(),
            "plan_id": self.plan_id,
            "plan_version": self.plan_version,
            "approval_decision_id": self.approval_decision_id,
            "admission_id": self.admission_id,
            "budget_snapshot_hash": self.budget_snapshot_hash,
            "budget_id": self.budget_id,
            "approved_commitment": self.approved_commitment,
            "reserve_amount": self.reserve_amount,
            "currency": self.currency,
            "permitted_provider": self.permitted_provider,
            "permitted_model_id": self.permitted_model_id,
            "permitted_mode": self.permitted_mode.value,
            "usage_ceiling": self.usage_ceiling.canonical_payload(),
            "stop_conditions": sorted(f"{c.kind.value}:{c.description}"
                                      for c in self.stop_conditions),
            "valid_from": self.valid_from,
            "expires_at": self.expires_at,
            "acknowledgements": [a.canonical_payload() for a in
                                 sorted(self.acknowledgements,
                                        key=lambda a: a.code.value)],
            "markers": sorted(self.markers),
            "issued_by": self.issued_by,
        }
