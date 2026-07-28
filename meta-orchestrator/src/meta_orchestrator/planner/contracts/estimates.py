"""Estimate shapes: tokens, cost, time, confidence, and the version that produced them.

Every estimate carries the identity of the estimator and the pricing it was computed
under. Without that pair an estimate cannot be reproduced, cannot be compared against
a later one, and cannot be rolled back — the §2 apparatus bound its pricing hash into
the authorization anchor for exactly this reason, and the same discipline applies here.

Nothing in this module computes an estimate. It only defines what one looks like.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .money import Money, MoneyRange


class Confidence(str, Enum):
    """Qualitative confidence in an estimate.

    Deliberately coarse. A numeric probability would imply a calibration this system
    has not earned: §2 found its one measured effect indistinguishable from noise at
    n=8, and no estimator here has yet been checked against a single actual.
    """

    UNKNOWN = "unknown"      # no basis at all — first sighting of this task family
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ConfidenceRange(BaseModel):
    """A confidence label plus the evidence that justifies it.

    ``basis`` is mandatory prose. A confidence with no stated basis is the failure mode
    §2 was built to avoid — a number that looks like evidence and is not.
    """

    model_config = ConfigDict(frozen=True)

    level: Confidence = Confidence.UNKNOWN
    basis: str
    n_observations: int = 0
    #: How much of the estimate rests on assumptions rather than measurement, 0..1.
    assumption_load: Decimal = Decimal("1")

    @model_validator(mode="after")
    def _honest(self) -> "ConfidenceRange":
        if not self.basis.strip():
            raise ValueError("ConfidenceRange.basis must say what the confidence rests on")
        if self.n_observations < 0:
            raise ValueError("n_observations cannot be negative")
        if not (Decimal(0) <= self.assumption_load <= Decimal(1)):
            raise ValueError("assumption_load must lie in [0, 1]")
        # Guard against the specific overconfidence §2 warns about: a strong claim
        # backed by a handful of observations.
        if self.level is Confidence.HIGH and self.n_observations < 30:
            raise ValueError(
                f"HIGH confidence needs >= 30 observations, got {self.n_observations} — "
                "use MEDIUM and say so in the basis"
            )
        return self


class EstimatorVersion(BaseModel):
    """Identity of the estimator and the pricing snapshot behind one estimate.

    ``pricing_ref`` is an opaque handle to whatever the pricing source of truth turns
    out to be — a content hash, a row id, a file digest. P0 does not choose that source
    (see the architecture note); it only requires that the estimate name it.
    """

    model_config = ConfigDict(frozen=True)

    estimator_id: str          # e.g. "rules-v1"
    estimator_version: str     # e.g. "1.0.0"
    pricing_ref: str           # opaque; identifies the price the estimate was made under
    created_at: str            # ISO-8601

    @model_validator(mode="after")
    def _populated(self) -> "EstimatorVersion":
        for field in ("estimator_id", "estimator_version", "pricing_ref", "created_at"):
            if not getattr(self, field).strip():
                raise ValueError(f"EstimatorVersion.{field} must not be empty")
        return self


class TokenEstimate(BaseModel):
    """Token counts for one stage, split by how they are billed.

    Cache reads and writes are separate fields because they are separate line items on
    every provider that offers caching, and folding them into ``input`` understates a
    cached workload and overstates an uncached one. The product ``ModelSpec`` has no
    cache rates today; the contract carries the fields so the gap is visible rather
    than silently rounded away.
    """

    model_config = ConfigDict(frozen=True)

    input_tokens: int = 0
    output_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    #: Message calls to the provider, including expected retries.
    calls: int = 1
    #: Retries budgeted for. Distinct from ``rework_rounds``: a retry re-sends, a
    #: rework round is a fresh attempt after a failed verification.
    retries: int = 0
    rework_rounds: int = 0

    @model_validator(mode="after")
    def _non_negative(self) -> "TokenEstimate":
        for field in ("input_tokens", "output_tokens", "cache_write_tokens",
                      "cache_read_tokens", "calls", "retries", "rework_rounds"):
            if getattr(self, field) < 0:
                raise ValueError(f"TokenEstimate.{field} cannot be negative")
        if self.calls < 1:
            raise ValueError("TokenEstimate.calls must be at least 1")
        return self

    @property
    def total_tokens(self) -> int:
        return (self.input_tokens + self.output_tokens
                + self.cache_write_tokens + self.cache_read_tokens)


class TokenEstimateRange(BaseModel):
    """best / expected / worst token counts. A single number is never sufficient."""

    model_config = ConfigDict(frozen=True)

    best: TokenEstimate
    expected: TokenEstimate
    worst: TokenEstimate

    @model_validator(mode="after")
    def _ordered(self) -> "TokenEstimateRange":
        if not (self.best.total_tokens <= self.expected.total_tokens
                <= self.worst.total_tokens):
            raise ValueError("TokenEstimateRange must satisfy best <= expected <= worst")
        return self


class CostEstimate(BaseModel):
    """Money for one stage or a whole plan, with the provenance to reproduce it.

    ``worst_reasonable`` is a defensible upper bound, NOT a hard cap: the cap is an
    operator decision and lives in :mod:`.budget`. Conflating the two is what lets a
    plan quietly authorise itself.
    """

    model_config = ConfigDict(frozen=True)

    range: MoneyRange
    confidence: ConfidenceRange
    estimator: EstimatorVersion
    #: Named drivers that could push the figure toward ``worst``. Free prose, but
    #: required — "what would make this cost more" is the question users actually ask.
    cost_drivers: list[str] = Field(default_factory=list)

    @property
    def expected(self) -> Money:
        return self.range.expected

    @property
    def worst_reasonable(self) -> Money:
        return self.range.worst


class TimeEstimate(BaseModel):
    """Wall-clock for one stage, separating the kinds of waiting.

    Compute, provider latency, human involvement and external blocking behave nothing
    alike under parallelism, so a single duration cannot be scheduled against.
    """

    model_config = ConfigDict(frozen=True)

    compute_ms: int = 0
    provider_wait_ms: int = 0
    verification_ms: int = 0
    human_ms: int = 0
    external_blocked_ms: int = 0

    @model_validator(mode="after")
    def _non_negative(self) -> "TimeEstimate":
        for field in ("compute_ms", "provider_wait_ms", "verification_ms",
                      "human_ms", "external_blocked_ms"):
            if getattr(self, field) < 0:
                raise ValueError(f"TimeEstimate.{field} cannot be negative")
        return self

    @property
    def total_ms(self) -> int:
        return (self.compute_ms + self.provider_wait_ms + self.verification_ms
                + self.human_ms + self.external_blocked_ms)


class TimeEstimateRange(BaseModel):
    """best / expected / worst wall-clock."""

    model_config = ConfigDict(frozen=True)

    best: TimeEstimate
    expected: TimeEstimate
    worst: TimeEstimate

    @model_validator(mode="after")
    def _ordered(self) -> "TimeEstimateRange":
        if not (self.best.total_ms <= self.expected.total_ms <= self.worst.total_ms):
            raise ValueError("TimeEstimateRange must satisfy best <= expected <= worst")
        return self
