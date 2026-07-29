"""What actually happened, and how far it drifted from what was estimated.

The observability fields here are not optional and are not a wish-list. The §2
research closeout records that the Gate-A failure could not be localised — model,
prompt or parser — **because raw responses were not retained**, and it makes
persisting them a non-negotiable precondition for any future work:

    exact raw provider response (byte-for-byte) · ordered content blocks + block types
    · the exact text supplied to the parser · stop_reason + usage metadata ·
    raw-response SHA-256 · parser version/hash + the exact parser error ·
    raw evidence preserved BEFORE any outcome summarization

:class:`ActualUsage` carries all seven. ``assert_observability_complete`` is the check
that must pass on a synthetic fixture and a dry run before the first paid call.

This module defines collection only. No learning, no calibration, no estimator update
— those need actuals that do not exist yet, and §2 is the standing reminder of what
happens when a mechanism is trusted before it is measured.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .money import Money


class OutcomeStatus(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    #: The call may or may not have been processed and billed. Never auto-retried,
    #: never counted as a clean failure — §2's call journal treats this as a state a
    #: human has to resolve.
    AMBIGUOUS = "ambiguous"
    ABORTED_BUDGET = "aborted_budget"
    ABORTED_APPROVAL = "aborted_approval"


class VarianceSource(str, Enum):
    """Where an overrun came from. Needed before any calibration is meaningful.

    ``APPARATUS`` earns its place from §2: 19 of 32 primary cells produced no valid
    patch, so the headline number measured the harness, not the hypothesis. An
    estimator that learns from apparatus failures learns the wrong thing.
    """

    UNKNOWN = "unknown"
    ESTIMATE_ERROR = "estimate_error"
    SCOPE_CHANGE = "scope_change"
    RETRIES = "retries"
    REWORK = "rework"
    CACHE_MISS = "cache_miss"
    PRICE_CHANGE = "price_change"
    APPARATUS = "apparatus"
    EXTERNAL = "external"


class RawEvidence(BaseModel):
    """The seven mandatory observability fields, captured before summarisation."""

    model_config = ConfigDict(frozen=True)

    raw_response: str
    raw_response_sha256: str
    content_blocks: list[dict] = Field(default_factory=list)
    parser_input: str
    stop_reason: str
    parser_version: str
    parser_error: str = ""

    @model_validator(mode="after")
    def _present(self) -> "RawEvidence":
        for field in ("raw_response", "raw_response_sha256", "parser_input",
                      "stop_reason", "parser_version"):
            if not getattr(self, field).strip():
                raise ValueError(
                    f"RawEvidence.{field} is mandatory — see the §2 closeout: a run "
                    "whose failure cannot be localised is a run that has to be repeated"
                )
        if not self.content_blocks:
            raise ValueError("RawEvidence.content_blocks must record the ordered blocks")
        return self


class ActualUsage(BaseModel):
    """Reconciled reality for one stage or call."""

    model_config = ConfigDict(frozen=True)

    usage_id: str
    plan_id: str
    stage_id: str | None = None
    model_id: str
    provider: str

    input_tokens: int = 0
    output_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    calls: int = 0
    retries: int = 0
    rework_rounds: int = 0
    verification_rounds: int = 0

    duration_ms: int = 0
    human_minutes: int = 0
    cost: Money
    status: OutcomeStatus
    #: Absent only when the call never reached the provider (blocked pre-send).
    evidence: RawEvidence | None = None
    recorded_at: str = ""

    @model_validator(mode="after")
    def _consistent(self) -> "ActualUsage":
        for field in ("input_tokens", "output_tokens", "cache_write_tokens",
                      "cache_read_tokens", "calls", "retries", "rework_rounds",
                      "verification_rounds", "duration_ms", "human_minutes"):
            if getattr(self, field) < 0:
                raise ValueError(f"ActualUsage.{field} cannot be negative")
        if self.cost.is_negative():
            raise ValueError("actual cost cannot be negative")
        # A call that reached the provider must carry its evidence; one blocked before
        # send legitimately has none, and no other combination is coherent.
        reached_provider = self.status in (OutcomeStatus.SUCCEEDED, OutcomeStatus.FAILED,
                                           OutcomeStatus.AMBIGUOUS)
        if reached_provider and self.calls > 0 and self.evidence is None:
            raise ValueError(
                f"status={self.status.value} with calls={self.calls} requires RawEvidence"
            )
        return self

    @property
    def total_tokens(self) -> int:
        return (self.input_tokens + self.output_tokens
                + self.cache_write_tokens + self.cache_read_tokens)


def assert_observability_complete(usage: ActualUsage) -> None:
    """Pre-flight check demanded by the §2 closeout.

    Must pass on a synthetic fixture **and** one dry run before any paid call. Raises
    rather than returning a flag: a soft warning is what let the Gate-A evidence go
    missing in the first place.
    """
    from .errors import ObservabilityIncompleteError

    if usage.evidence is None:
        raise ObservabilityIncompleteError(usage.usage_id, "no RawEvidence attached")
    missing = [name for name in ("raw_response", "raw_response_sha256", "parser_input",
                                 "stop_reason", "parser_version")
               if not getattr(usage.evidence, name).strip()]
    if not usage.evidence.content_blocks:
        missing.append("content_blocks")
    if missing:
        raise ObservabilityIncompleteError(usage.usage_id, f"missing: {sorted(missing)}")


class EstimateVariance(BaseModel):
    """Estimated versus actual for one plan — the input calibration will one day need.

    Recorded per plan and per estimator version so that when calibration is eventually
    built it can be scoped by task family and rolled back, rather than fitted across
    everything at once.
    """

    model_config = ConfigDict(frozen=True)

    plan_id: str
    plan_version: int
    estimator_ref: str
    task_family: str

    estimated_input_tokens: int
    actual_input_tokens: int
    estimated_output_tokens: int
    actual_output_tokens: int
    estimated_cost: Money
    actual_cost: Money
    estimated_duration_ms: int
    actual_duration_ms: int
    estimated_retries: int
    actual_retries: int
    estimated_verification_rounds: int
    actual_verification_rounds: int
    estimated_human_minutes: int = 0
    actual_human_minutes: int = 0
    #: For HUMAN_ASSISTED: what the hybrid route was projected to save versus what it did.
    expected_hybrid_saving: Money | None = None
    actual_hybrid_saving: Money | None = None

    breached_cap: bool = False
    variance_source: VarianceSource = VarianceSource.UNKNOWN
    #: Prose. An unexplained variance is an observation, not a lesson.
    explanation: str = ""

    @model_validator(mode="after")
    def _consistent(self) -> "EstimateVariance":
        if self.estimated_cost.currency != self.actual_cost.currency:
            raise ValueError("estimated and actual cost must share one currency")
        if (self.variance_source is not VarianceSource.UNKNOWN
                and not self.explanation.strip()):
            raise ValueError("a classified variance must carry its explanation")
        return self

    @property
    def cost_delta(self) -> Money:
        return self.actual_cost - self.estimated_cost

    def cost_variance_pct(self) -> Decimal | None:
        """Percent over/under. ``None`` when the estimate was zero — not 0, not inf."""
        if self.estimated_cost.amount == 0:
            return None
        return (self.cost_delta.amount / self.estimated_cost.amount) * Decimal(100)

    def duration_variance_pct(self) -> Decimal | None:
        if self.estimated_duration_ms == 0:
            return None
        delta = Decimal(self.actual_duration_ms - self.estimated_duration_ms)
        return (delta / Decimal(self.estimated_duration_ms)) * Decimal(100)

    def is_usable_for_calibration(self) -> bool:
        """Whether this observation may inform a future estimator.

        Apparatus failures and unclassified variances are excluded by construction.
        This is the §2 lesson encoded as a predicate: a mechanism that trains on its
        own harness bugs will confidently learn nothing.
        """
        return (self.variance_source not in (VarianceSource.UNKNOWN,
                                             VarianceSource.APPARATUS)
                and bool(self.explanation.strip()))
