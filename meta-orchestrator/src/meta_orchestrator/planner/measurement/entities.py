"""Measurement artifacts (P2m §10, §12, §14).

Two things live here: the raw observation (:class:`TokenMeasurement`), one per sample,
content-addressed; and the analysis that aggregates observations by content family. A
:class:`CalibrationProposal` may be *derived* from measurements, but it is documentation
only — nothing here applies it, and it carries no basis unless real measurements exist.

The measured column is optional throughout. When no credential is available the pilot
records the offline half — legacy estimate vs Planner band — and leaves ``measured_*``
empty rather than inventing a number.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum
from statistics import median
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..estimation.metrics import ContentFamily, ScriptHint
from ..governance.canonical import CanonicalMixin, content_hash


def _pct(part: int, whole: int) -> Optional[Decimal]:
    if whole <= 0:
        return None
    return (Decimal(abs(part)) / Decimal(whole)).quantize(Decimal("0.0001"))


def _ratio(a: int, b: int) -> Optional[Decimal]:
    if b <= 0:
        return None
    return (Decimal(a) / Decimal(b)).quantize(Decimal("0.0001"))


class CountingMethod(str, Enum):
    """How the measured count was obtained — or that it was not."""

    PROVIDER_COUNT_TOKENS_API = "provider_count_tokens_api"
    NOT_MEASURED = "not_measured"


class TokenMeasurement(BaseModel, CanonicalMixin):
    """One sample: what the heuristic said, what the Planner said, what was measured."""

    model_config = ConfigDict(frozen=True)

    schema_version: str = "token-measurement-v1"
    measurement_id: str
    sample_id: str
    sample_content_hash: str

    provider: str
    model_id: str
    counting_method: CountingMethod
    requested_at: str = ""
    completed_at: str = ""

    # measured facts about the input
    input_bytes: int
    code_points: int
    words: int
    lines: int
    content_family: ContentFamily
    script_hint: ScriptHint

    # estimates (always present — offline)
    legacy_tokens: int
    planner_best: int
    planner_expected: int
    planner_worst: int

    # legacy-vs-Planner, offline (no measurement needed)
    legacy_in_planner_range: bool

    # measured column (present only when a real count was taken)
    measured_tokens: Optional[int] = None
    request_id: Optional[str] = None

    # errors against the measured count (None when not measured)
    legacy_abs_error: Optional[int] = None
    legacy_pct_error: Optional[Decimal] = None
    planner_expected_abs_error: Optional[int] = None
    planner_expected_pct_error: Optional[Decimal] = None
    measured_in_planner_range: Optional[bool] = None
    code_points_per_measured_token: Optional[Decimal] = None
    bytes_per_measured_token: Optional[Decimal] = None

    warnings: list[str] = Field(default_factory=list)

    @property
    def measured_available(self) -> bool:
        return self.measured_tokens is not None

    def canonical_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "measurement_id": self.measurement_id,
            "sample_id": self.sample_id,
            "sample_content_hash": self.sample_content_hash,
            "provider": self.provider,
            "model_id": self.model_id,
            "counting_method": self.counting_method.value,
            "requested_at": self.requested_at,
            "completed_at": self.completed_at,
            "input_bytes": self.input_bytes,
            "code_points": self.code_points,
            "words": self.words,
            "lines": self.lines,
            "content_family": self.content_family.value,
            "script_hint": self.script_hint.value,
            "legacy_tokens": self.legacy_tokens,
            "planner_best": self.planner_best,
            "planner_expected": self.planner_expected,
            "planner_worst": self.planner_worst,
            "legacy_in_planner_range": self.legacy_in_planner_range,
            "measured_tokens": self.measured_tokens,
            "request_id": self.request_id,
            "legacy_abs_error": self.legacy_abs_error,
            "legacy_pct_error": None if self.legacy_pct_error is None else str(self.legacy_pct_error),
            "planner_expected_abs_error": self.planner_expected_abs_error,
            "planner_expected_pct_error": (None if self.planner_expected_pct_error is None
                                           else str(self.planner_expected_pct_error)),
            "measured_in_planner_range": self.measured_in_planner_range,
            "code_points_per_measured_token": (None if self.code_points_per_measured_token is None
                                               else str(self.code_points_per_measured_token)),
            "bytes_per_measured_token": (None if self.bytes_per_measured_token is None
                                         else str(self.bytes_per_measured_token)),
            "warnings": list(self.warnings),
        }

    def content_hash(self) -> str:
        return content_hash(self.canonical_payload())


def build_measurement(*, measurement_id: str, sample_id: str, sample_content_hash: str,
                      provider: str, model_id: str, counting_method: CountingMethod,
                      input_bytes: int, code_points: int, words: int, lines: int,
                      content_family: ContentFamily, script_hint: ScriptHint,
                      legacy_tokens: int, planner_best: int, planner_expected: int,
                      planner_worst: int, measured_tokens: Optional[int] = None,
                      request_id: Optional[str] = None, requested_at: str = "",
                      completed_at: str = "", warnings: Optional[list[str]] = None,
                      ) -> TokenMeasurement:
    """Assemble a measurement, computing the error columns when a count is present."""
    warns = list(warnings or [])
    legacy_in_range = planner_best <= legacy_tokens <= planner_worst

    kw: dict[str, Any] = {}
    if measured_tokens is not None:
        kw.update(
            legacy_abs_error=abs(legacy_tokens - measured_tokens),
            legacy_pct_error=_pct(legacy_tokens - measured_tokens, measured_tokens),
            planner_expected_abs_error=abs(planner_expected - measured_tokens),
            planner_expected_pct_error=_pct(planner_expected - measured_tokens, measured_tokens),
            measured_in_planner_range=(planner_best <= measured_tokens <= planner_worst),
            code_points_per_measured_token=_ratio(code_points, measured_tokens),
            bytes_per_measured_token=_ratio(input_bytes, measured_tokens),
        )

    return TokenMeasurement(
        measurement_id=measurement_id, sample_id=sample_id,
        sample_content_hash=sample_content_hash, provider=provider, model_id=model_id,
        counting_method=counting_method, requested_at=requested_at,
        completed_at=completed_at, input_bytes=input_bytes, code_points=code_points,
        words=words, lines=lines, content_family=content_family, script_hint=script_hint,
        legacy_tokens=legacy_tokens, planner_best=planner_best,
        planner_expected=planner_expected, planner_worst=planner_worst,
        legacy_in_planner_range=legacy_in_range, measured_tokens=measured_tokens,
        request_id=request_id, warnings=warns, **kw)


class FamilyAnalysis(BaseModel):
    """Aggregated findings for one content family. Measured fields are None when blocked."""

    model_config = ConfigDict(frozen=True)

    family: ContentFamily
    sample_count: int

    # offline (always available)
    median_legacy_tokens: int
    median_planner_expected: int
    legacy_in_planner_range_rate: Decimal

    # measured (None when no measurement was taken)
    measured_available: bool = False
    median_measured_tokens: Optional[int] = None
    median_code_points_per_token: Optional[Decimal] = None
    legacy_median_abs_pct_error: Optional[Decimal] = None
    planner_expected_median_abs_pct_error: Optional[Decimal] = None
    planner_range_coverage: Optional[Decimal] = None
    under_estimation_rate: Optional[Decimal] = None
    over_estimation_rate: Optional[Decimal] = None
    worst_under_estimation_pct: Optional[Decimal] = None
    worst_over_estimation_pct: Optional[Decimal] = None

    @classmethod
    def of(cls, family: ContentFamily, rows: list[TokenMeasurement]) -> "FamilyAnalysis":
        n = len(rows)
        in_range = sum(1 for r in rows if r.legacy_in_planner_range)
        base = dict(
            family=family, sample_count=n,
            median_legacy_tokens=int(median([r.legacy_tokens for r in rows])),
            median_planner_expected=int(median([r.planner_expected for r in rows])),
            legacy_in_planner_range_rate=(Decimal(in_range) / Decimal(n)).quantize(Decimal("0.01")),
        )
        measured = [r for r in rows if r.measured_available]
        if not measured:
            return cls(**base)

        # Planner under/over estimation is relative to the measured truth.
        under = sum(1 for r in measured if r.planner_expected < r.measured_tokens)
        over = sum(1 for r in measured if r.planner_expected > r.measured_tokens)
        cov = sum(1 for r in measured if r.measured_in_planner_range)
        legacy_errs = [r.legacy_pct_error for r in measured if r.legacy_pct_error is not None]
        plan_errs = [r.planner_expected_pct_error for r in measured
                     if r.planner_expected_pct_error is not None]
        under_pcts = [r.planner_expected_pct_error for r in measured
                      if r.planner_expected_pct_error is not None
                      and r.planner_expected < r.measured_tokens]
        over_pcts = [r.planner_expected_pct_error for r in measured
                     if r.planner_expected_pct_error is not None
                     and r.planner_expected > r.measured_tokens]
        cpt = [r.code_points_per_measured_token for r in measured
               if r.code_points_per_measured_token is not None]
        m = len(measured)
        return cls(
            measured_available=True,
            median_measured_tokens=int(median([r.measured_tokens for r in measured])),
            median_code_points_per_token=median(cpt) if cpt else None,
            legacy_median_abs_pct_error=median(legacy_errs) if legacy_errs else None,
            planner_expected_median_abs_pct_error=median(plan_errs) if plan_errs else None,
            planner_range_coverage=(Decimal(cov) / Decimal(m)).quantize(Decimal("0.01")),
            under_estimation_rate=(Decimal(under) / Decimal(m)).quantize(Decimal("0.01")),
            over_estimation_rate=(Decimal(over) / Decimal(m)).quantize(Decimal("0.01")),
            worst_under_estimation_pct=max(under_pcts) if under_pcts else None,
            worst_over_estimation_pct=max(over_pcts) if over_pcts else None,
            **base)


class CalibrationProposal(BaseModel):
    """A documented suggestion to change a coefficient. NEVER applied by P2m (§14).

    Produced only when a measured basis exists. It records the current and measured
    values, how many samples back it, and an explicit recommendation and confidence —
    for a human to weigh, not for the estimator to act on.
    """

    model_config = ConfigDict(frozen=True)

    family: ContentFamily
    current_expected_cp_per_token: str
    measured_median_cp_per_token: str
    sample_count: int
    coverage_impact_note: str
    recommendation: str
    confidence: str = "low"
    limitations: list[str] = Field(default_factory=list)
    applied: bool = False        # always False in P2m — documentation only
