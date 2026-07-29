"""Blocking conditions, acknowledgeable warnings, and notes.

The distinction is the point. A blocking condition **cannot be acknowledged away** —
no signature, no override flag, no "I understand the risk" makes a stale snapshot
fresh or a fictional price real. An acknowledgeable warning is a genuine judgement
call the approver is entitled to make, and the record has to show that they made it.

Collapsing the two is how a governance layer becomes theatre: everything becomes a
checkbox, and the checkboxes all get ticked.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .canonical import CanonicalMixin


class ConditionSeverity(str, Enum):
    #: Stops the decision. Not waivable by anyone, for any reason.
    BLOCKING = "blocking"
    #: A real risk the approver may accept, but only explicitly and on the record.
    ACKNOWLEDGEABLE = "acknowledgeable"
    #: Context. Needs no response.
    INFORMATIONAL = "informational"


class ConditionCode(str, Enum):
    """The conditions this system knows how to raise."""

    # --- blocking ---
    BUDGET_BREACH = "budget_breach"
    NON_AUTHORITATIVE_PRICE = "non_authoritative_price"
    FICTIONAL_PRICE_IN_REAL_SPEND = "fictional_price_in_real_spend"
    WORST_COST_UNAVAILABLE = "worst_cost_unavailable"
    UNBOUNDED_ESTIMATE = "unbounded_estimate"
    PARTIAL_ESTIMATE_IN_REAL_SPEND = "partial_estimate_in_real_spend"
    STALE_BUDGET_SNAPSHOT = "stale_budget_snapshot"
    CURRENCY_MISMATCH = "currency_mismatch"
    INVALID_HASH = "invalid_hash"
    EXPIRED_ADMISSION = "expired_admission"
    PRICE_TOO_OLD = "price_too_old"
    RESERVE_MODE_NOT_PERMITTED = "reserve_mode_not_permitted"
    MISSING_DELIVERABLES = "missing_deliverables"
    PURPOSE_MISMATCH = "purpose_mismatch"

    # --- acknowledgeable ---
    CONFIDENCE_UNKNOWN = "confidence_unknown"
    HEURISTIC_ESTIMATOR = "heuristic_estimator"
    TIME_ESTIMATE_UNAVAILABLE = "time_estimate_unavailable"
    PRICE_NOT_PROVIDER_VERIFIED = "price_not_provider_verified"
    RETRY_HEURISTIC = "retry_heuristic"
    REPEATED_CONTEXT_UNCACHED = "repeated_context_uncached"
    HUMAN_ONLY_WITHOUT_REVIEW = "human_only_without_review"
    NO_PRICE_FRESHNESS_POLICY = "no_price_freshness_policy"

    # --- informational ---
    RESERVE_APPLIED = "reserve_applied"
    THRESHOLD_CROSSED = "threshold_crossed"
    SIMULATION_ARTIFACT = "simulation_artifact"


#: Severity is a property of the condition, not of the caller's mood.
_SEVERITY: dict[ConditionCode, ConditionSeverity] = {
    **{c: ConditionSeverity.BLOCKING for c in (
        ConditionCode.BUDGET_BREACH,
        ConditionCode.NON_AUTHORITATIVE_PRICE,
        ConditionCode.FICTIONAL_PRICE_IN_REAL_SPEND,
        ConditionCode.WORST_COST_UNAVAILABLE,
        ConditionCode.UNBOUNDED_ESTIMATE,
        ConditionCode.PARTIAL_ESTIMATE_IN_REAL_SPEND,
        ConditionCode.STALE_BUDGET_SNAPSHOT,
        ConditionCode.CURRENCY_MISMATCH,
        ConditionCode.INVALID_HASH,
        ConditionCode.EXPIRED_ADMISSION,
        ConditionCode.PRICE_TOO_OLD,
        ConditionCode.RESERVE_MODE_NOT_PERMITTED,
        ConditionCode.MISSING_DELIVERABLES,
        ConditionCode.PURPOSE_MISMATCH,
    )},
    **{c: ConditionSeverity.ACKNOWLEDGEABLE for c in (
        ConditionCode.CONFIDENCE_UNKNOWN,
        ConditionCode.HEURISTIC_ESTIMATOR,
        ConditionCode.TIME_ESTIMATE_UNAVAILABLE,
        ConditionCode.PRICE_NOT_PROVIDER_VERIFIED,
        ConditionCode.RETRY_HEURISTIC,
        ConditionCode.REPEATED_CONTEXT_UNCACHED,
        ConditionCode.HUMAN_ONLY_WITHOUT_REVIEW,
        ConditionCode.NO_PRICE_FRESHNESS_POLICY,
    )},
    **{c: ConditionSeverity.INFORMATIONAL for c in (
        ConditionCode.RESERVE_APPLIED,
        ConditionCode.THRESHOLD_CROSSED,
        ConditionCode.SIMULATION_ARTIFACT,
    )},
}


def severity_of(code: ConditionCode) -> ConditionSeverity:
    return _SEVERITY[code]


class Condition(BaseModel, CanonicalMixin):
    """One raised condition, with its severity fixed by its code."""

    model_config = ConfigDict(frozen=True)

    code: ConditionCode
    detail: str
    severity: ConditionSeverity | None = None

    @model_validator(mode="after")
    def _severity_is_not_the_callers_choice(self) -> "Condition":
        expected = severity_of(self.code)
        if self.severity is not None and self.severity is not expected:
            raise ValueError(
                f"{self.code.value} is {expected.value}; a caller cannot reclassify it")
        if self.severity is None:
            object.__setattr__(self, "severity", expected)
        if not self.detail.strip():
            raise ValueError("a condition must explain itself")
        return self

    @property
    def is_blocking(self) -> bool:
        return self.severity is ConditionSeverity.BLOCKING

    @property
    def needs_acknowledgement(self) -> bool:
        return self.severity is ConditionSeverity.ACKNOWLEDGEABLE

    def canonical_payload(self) -> dict:
        return {"code": self.code.value, "severity": self.severity.value,
                "detail": self.detail}


class Acknowledgement(BaseModel, CanonicalMixin):
    """A person accepting one named, acknowledgeable risk."""

    model_config = ConfigDict(frozen=True)

    code: ConditionCode
    acknowledged_by: str
    acknowledged_at: str
    note: str = ""

    @model_validator(mode="after")
    def _accountable(self) -> "Acknowledgement":
        if not self.acknowledged_by.strip():
            raise ValueError("an acknowledgement must name who gave it")
        if severity_of(self.code) is ConditionSeverity.BLOCKING:
            raise ValueError(
                f"{self.code.value} is a blocking condition and cannot be acknowledged "
                "away — it has to be resolved")
        return self

    def canonical_payload(self) -> dict:
        return {"code": self.code.value, "acknowledged_by": self.acknowledged_by,
                "acknowledged_at": self.acknowledged_at, "note": self.note}


class ConditionSet(BaseModel, CanonicalMixin):
    """Everything raised about one decision, in one place."""

    model_config = ConfigDict(frozen=True)

    conditions: list[Condition] = Field(default_factory=list)

    @property
    def blocking(self) -> list[Condition]:
        return [c for c in self.conditions if c.is_blocking]

    @property
    def acknowledgeable(self) -> list[Condition]:
        return [c for c in self.conditions if c.needs_acknowledgement]

    @property
    def informational(self) -> list[Condition]:
        return [c for c in self.conditions
                if c.severity is ConditionSeverity.INFORMATIONAL]

    @property
    def is_clear(self) -> bool:
        return not self.blocking

    def missing_acknowledgements(
            self, given: list[Acknowledgement]) -> list[ConditionCode]:
        """Acknowledgeable conditions nobody has signed off."""
        signed = {a.code for a in given}
        return sorted((c.code for c in self.acknowledgeable if c.code not in signed),
                      key=lambda c: c.value)

    def with_condition(self, code: ConditionCode, detail: str) -> "ConditionSet":
        return ConditionSet(conditions=[*self.conditions,
                                        Condition(code=code, detail=detail)])

    def canonical_payload(self) -> dict:
        return {"conditions": [c.canonical_payload()
                               for c in sorted(self.conditions,
                                               key=lambda c: (c.code.value, c.detail))]}
