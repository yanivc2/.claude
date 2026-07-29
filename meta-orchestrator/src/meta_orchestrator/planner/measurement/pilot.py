"""The pilot runner (P2m §12, §15).

For every frozen sample it computes, on the *exact same input*:

* the legacy heuristic — ``code_points // 4``, which is G1;
* the rules-based Planner estimate — best / expected / worst input tokens;
* the measured count — only if a real counter is supplied.

The legacy and Planner columns are offline and always produced. The measured column is
produced only when a credential-backed counter is passed; otherwise it is left empty and
the run is marked BLOCKED. Nothing is invented.

The Planner estimate is produced by the estimator directly, on a single-stage request
built from the sample's own metrics — the same inputs the shadow adapter would use, so
there is no need to spin up the whole orchestrator per sample (§15).
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..contracts.plan import ExecutionMode
from ..contracts.scope import StageKind
from ..estimation.entities import UsageEstimate
from ..estimation.estimator import UsageEstimator
from ..estimation.metrics import ContentFamily, ContentMetrics, RequestOverheads, ScriptHint
from ..estimation.profiles import ESTIMATOR_ID, ESTIMATOR_VERSION, RULESET_VERSION
from ..estimation.request import EstimationRequest, StageInput
from .budget import PilotBudget
from .corpus import CORPUS, CORPUS_VERSION, SYSTEM_PROMPT_OVERHEAD, TOOL_SCHEMA_OVERHEAD, Sample
from .counter import PILOT_MODEL_SNAPSHOT, TokenCounter
from .entities import CountingMethod, FamilyAnalysis, TokenMeasurement, build_measurement
from .errors import PilotBudgetExhaustedError

PILOT_MODEL_ID = "claude-haiku-4-5"
PILOT_PROVIDER = "anthropic"


def legacy_estimate(code_points: int) -> int:
    """The runtime heuristic under test: ``chars // 4`` (G1). No framing, no floor."""
    return code_points // 4


def _estimator() -> UsageEstimator:
    return UsageEstimator()


def planner_input_band(estimator: UsageEstimator, metrics: ContentMetrics,
                       *, overheads: Optional[RequestOverheads] = None) -> tuple[int, int, int]:
    """The Planner's (best, expected, worst) INPUT-token band for one body of content.

    A single primary call, no retries, no verification — P2m measures input only, so the
    output profile does not enter the comparison.
    """
    stage = StageInput(
        stage_id="measure", kind=StageKind.GENERATE, inputs=[metrics],
        overheads=overheads or RequestOverheads(), primary_calls=1, max_retries=0,
        verification_rounds=0, output_profile_id="default_short")
    request = EstimationRequest(
        request_id="measure", scope_id="measure", plan_id="measure", plan_version=1,
        plan_hash="0" * 64, mode=ExecutionMode.AUTOMATIC, stages=[stage],
        candidate_model_ids=[])
    est: UsageEstimate = estimator.estimate(request)
    band = est.input_tokens
    return band.best, band.expected, band.worst


class PilotRun(BaseModel):
    """The whole pilot: metadata, raw observations, and analysis."""

    model_config = ConfigDict(frozen=True)

    corpus_version: str
    provider: str
    model_id: str
    counting_method: CountingMethod
    measured: bool
    blocked_reason: Optional[str] = None
    calls_made: int = 0
    budget_cap: str = ""
    budget_spent: str = ""
    estimator_id: str = ESTIMATOR_ID
    estimator_version: str = ESTIMATOR_VERSION
    ruleset_version: str = RULESET_VERSION
    generated_at: str = ""

    measurements: list[TokenMeasurement] = Field(default_factory=list)
    overhead_measurements: list[TokenMeasurement] = Field(default_factory=list)
    family_analyses: list[FamilyAnalysis] = Field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        content_rows = self.measurements
        legacy_in_range = sum(1 for r in content_rows if r.legacy_in_planner_range)
        out: dict[str, Any] = {
            "corpus_version": self.corpus_version,
            "provider": self.provider,
            "model_id": self.model_id,
            "counting_method": self.counting_method.value,
            "measured": self.measured,
            "blocked_reason": self.blocked_reason,
            "sample_count": len(content_rows),
            "calls_made": self.calls_made,
            "budget_cap": self.budget_cap,
            "budget_spent": self.budget_spent,
            "legacy_in_planner_range_count": legacy_in_range,
        }
        if self.measured:
            measured_rows = [r for r in content_rows if r.measured_available]
            covered = sum(1 for r in measured_rows if r.measured_in_planner_range)
            out["measured_sample_count"] = len(measured_rows)
            out["planner_range_coverage_count"] = covered
        return out


def _measure_one(sample: Sample, estimator: UsageEstimator, counter: Optional[TokenCounter],
                 *, system: Optional[str] = None, tools: Optional[list[dict]] = None,
                 warnings: Optional[list[str]] = None) -> TokenMeasurement:
    metrics = sample.metrics()
    overheads = None
    if system is not None or tools is not None:
        overheads = RequestOverheads(
            system_prompt_code_points=len(system) if system else 0,
            tool_schema_code_points=(len(str(tools)) if tools else 0),
            family=ContentFamily.PROSE_LATIN)
    best, expected, worst = planner_input_band(estimator, metrics, overheads=overheads)
    legacy = legacy_estimate(metrics.code_points +
                             (overheads.total_code_points if overheads else 0))

    measured_tokens = None
    request_id = None
    method = CountingMethod.NOT_MEASURED
    warns = list(warnings or [])
    if counter is not None:
        result = counter.count(sample.text, system=system, tools=tools)
        measured_tokens = result.input_tokens
        request_id = result.request_id
        method = result.method

    return build_measurement(
        measurement_id=f"m::{sample.sample_id}", sample_id=sample.sample_id,
        sample_content_hash=sample.content_hash, provider=PILOT_PROVIDER,
        model_id=PILOT_MODEL_ID, counting_method=method,
        input_bytes=metrics.utf8_bytes, code_points=metrics.code_points,
        words=metrics.words, lines=metrics.lines, content_family=sample.family,
        script_hint=sample.script, legacy_tokens=legacy, planner_best=best,
        planner_expected=expected, planner_worst=worst, measured_tokens=measured_tokens,
        request_id=request_id, warnings=warns)


def run_pilot(*, now: Callable[[], str], counter: Optional[TokenCounter] = None,
              budget: Optional[PilotBudget] = None, samples: Optional[list[Sample]] = None,
              blocked_reason: Optional[str] = None) -> PilotRun:
    """Run the pilot over the corpus.

    ``counter=None`` produces the offline legacy-vs-Planner comparison only, and marks
    the run BLOCKED (measurement not taken). A supplied counter fills the measured column
    within its budget; if the budget is exhausted mid-run the remaining samples stay
    unmeasured and a reason is recorded, rather than raising past the caller.
    """
    est = _estimator()
    samples = samples if samples is not None else CORPUS
    # The counter owns the authoritative budget (it is what gates each call); the run
    # reports that one, so calls and spend are never accounted against a phantom budget.
    budget = getattr(counter, "budget", None) or budget or PilotBudget()
    measured = counter is not None
    reason = blocked_reason if not measured else None

    rows: list[TokenMeasurement] = []
    for s in samples:
        try:
            rows.append(_measure_one(s, est, counter))
        except PilotBudgetExhaustedError as exc:
            reason = f"budget exhausted after {budget.calls_made} calls: {exc}"
            rows.append(_measure_one(s, est, None,
                                     warnings=[f"unmeasured: {reason}"]))
            counter = None      # stop measuring; keep computing offline columns

    measured = measured and any(r.measured_available for r in rows)

    # Overhead observations (§16): system prompt and tool schema, measured separately.
    overhead_rows: list[TokenMeasurement] = []
    overhead_specs = [
        Sample(sample_id="overhead_system_prompt", family=ContentFamily.PROSE_LATIN,
               size="fixed", script=ScriptHint.LATIN, text=SYSTEM_PROMPT_OVERHEAD),
        Sample(sample_id="overhead_tool_schema", family=ContentFamily.TOOL_SCHEMA,
               size="fixed", script=ScriptHint.LATIN, text=TOOL_SCHEMA_OVERHEAD),
    ]
    for spec in overhead_specs:
        try:
            overhead_rows.append(_measure_one(spec, est, counter))
        except PilotBudgetExhaustedError:
            overhead_rows.append(_measure_one(spec, est, None,
                                              warnings=["unmeasured: budget exhausted"]))

    families = []
    seen: set[ContentFamily] = set()
    for r in rows:
        if r.content_family in seen:
            continue
        seen.add(r.content_family)
        fam_rows = [x for x in rows if x.content_family is r.content_family]
        families.append(FamilyAnalysis.of(r.content_family, fam_rows))

    return PilotRun(
        corpus_version=CORPUS_VERSION, provider=PILOT_PROVIDER, model_id=PILOT_MODEL_ID,
        counting_method=(CountingMethod.PROVIDER_COUNT_TOKENS_API if measured
                         else CountingMethod.NOT_MEASURED),
        measured=measured, blocked_reason=reason, calls_made=budget.calls_made,
        budget_cap=f"{budget.cap.amount} {budget.cap.currency}",
        budget_spent=f"{budget.spent.amount} {budget.spent.currency}",
        generated_at=now(), measurements=rows, overhead_measurements=overhead_rows,
        family_analyses=families)
