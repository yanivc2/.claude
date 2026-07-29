"""Turn what the orchestrator is about to run into what the Planner can estimate.

The orchestrator hands the Planner a :class:`BugCase` and the models it would consider.
This module measures that input — code points, script, families — and expresses the
orchestrator's actual runtime shape as a small plan the estimator understands.

It stays inside the boundary named in P2a §9: it models **only** the seed task the
engine really runs (a code fix: generate, bounded retries, a synthesizer pass), and
does not invent stages for research, images, documents, or workflows the engine has no
path for. Verification in the orchestrator is a *tool* call (running the tests), not a
paid model call, so it contributes no model tokens and is not modelled as one.

Nothing here reads a file, a network, or a clock. The orchestrator already holds the
sources in memory; this only measures them. That is what keeps the estimate free of
side effects and safe to run in shadow.
"""
from __future__ import annotations

from ..contracts.plan import ExecutionMode
from ..contracts.scope import StageKind
from ..estimation.metrics import ContentFamily, ContentMetrics, ScriptHint
from ..estimation.request import EstimationRequest, StageInput
from ..governance.snapshots import PlanSnapshot, PlanStageSnapshot
from .case import ShadowCase

#: The shape the orchestrator actually runs. Stage ids are stable so a shadow result is
#: comparable across runs.
_GENERATE = "generate"
_SYNTHESIZE = "synthesize"


def code_metrics(source: str) -> ContentMetrics:
    """Measure a body of source code. Facts, not estimates."""
    return ContentMetrics(
        family=ContentFamily.SOURCE_CODE,
        utf8_bytes=len(source.encode("utf-8")),
        code_points=len(source),
        lines=source.count("\n") + (1 if source else 0),
        files=1,
        script=ScriptHint.LATIN,
    )


def build_stages(case: ShadowCase, *, max_rounds: int) -> list[StageInput]:
    """The orchestrator's real runtime, expressed as estimator stages.

    ``generate`` is shown both sources (module + tests) and writes the repaired module,
    with a bounded retry allowance matching the circuit breaker's ``max_rounds``.
    ``synthesize`` is the single coherent-output pass over the candidate the model
    produced. The independent verifier is code-level, not a model call, so it is absent.
    """
    module = code_metrics(case.module_source)
    tests = code_metrics(case.test_source)
    # Bounded retries only — an unbounded worst case is not a worst case, and the
    # estimator refuses it. The circuit breaker caps rounds at max_rounds.
    retry_allowance = max(0, max_rounds - 1)
    return [
        StageInput(
            stage_id=_GENERATE,
            kind=StageKind.GENERATE,
            inputs=[module, tests],
            primary_calls=1,
            max_retries=retry_allowance,
            verification_rounds=0,          # the test run is a tool call, not a model call
            output_profile_id="default_short",
            artifact_count=1,
        ),
        StageInput(
            stage_id=_SYNTHESIZE,
            kind=StageKind.SYNTHESIZE,
            depends_on=[_GENERATE],
            inputs=[module],                # the synthesizer works over the produced module
            primary_calls=1,
            max_retries=0,
            verification_rounds=0,
            output_profile_id="default_short",
            artifact_count=1,
        ),
    ]


def build_plan_snapshot(case: ShadowCase, *, candidate_model_ids: list[str],
                        stages: list[StageInput]) -> PlanSnapshot:
    """A canonical plan snapshot for the governance preview.

    Built directly from the same stages, rather than through a full ``ExecutionPlan``:
    the preview needs the plan's identity and shape, not a costed contract object. Its
    content hash becomes the request's ``plan_hash``, so the estimate and the governance
    preview reference one identical plan.
    """
    return PlanSnapshot(
        plan_id=f"shadow-plan::{case.bug_id}",
        plan_version=1,
        mode=ExecutionMode.AUTOMATIC,
        stages=[
            PlanStageSnapshot(
                stage_id=s.stage_id,
                kind=s.kind.value,
                depends_on=list(s.depends_on),
                blocking=s.blocking,
                parallelizable=s.parallelizable,
            )
            for s in stages
        ],
        model_ids=list(candidate_model_ids),
        deliverables=[f"repaired {case.module_filename}"],
        scope_id=f"shadow-scope::{case.bug_id}",
    )


def build_request(case: ShadowCase, *, candidate_model_ids: list[str],
                  max_rounds: int) -> tuple[EstimationRequest, PlanSnapshot]:
    """Build the estimation request and the matching plan snapshot for one case."""
    stages = build_stages(case, max_rounds=max_rounds)
    plan = build_plan_snapshot(
        case, candidate_model_ids=candidate_model_ids, stages=stages)
    request = EstimationRequest(
        request_id=f"shadow::{case.bug_id}",
        scope_id=plan.scope_id,
        plan_id=plan.plan_id,
        plan_version=plan.plan_version,
        plan_hash=plan.content_hash(),
        mode=ExecutionMode.AUTOMATIC,
        stages=stages,
        candidate_model_ids=list(candidate_model_ids),
        stated_assumptions=[
            "shadow pre-flight estimate for the seed code-fix task",
            "verification is a tool (test) call and costs no model tokens",
        ],
    )
    return request, plan
