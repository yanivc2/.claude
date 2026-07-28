"""The rules-based usage estimator — the product replacement for ``chars // 4``.

What it does: turns measured content into token bands, per stage, decomposed by call
kind, with every rule that contributed named in the result.

What it does not do: read files, call a model, look up a price, decide whether a run
may proceed, or claim a calibrated confidence. It is handed facts and returns numbers.

Three properties the implementation exists to hold:

* **Output is not a function of input.** Output comes from an explicit profile and an
  explicit cap. A short question about a large repository does not produce a long
  answer, and pretending otherwise is the category error in the current estimator.
* **Retries and verification are visible.** They are separate ``CallGroupEstimate``
  entries, not a multiplier folded into a total nobody can decompose.
* **No fallback.** Missing rule, unbounded retries, unclassifiable output — each
  raises. There is no path back to a silent default.
"""
from __future__ import annotations

from typing import Optional

from ..contracts.estimates import Confidence, ConfidenceRange
from ..contracts.scope import ClarifyingQuestion
from ..pricing.entities import full_sha256
from .entities import Band, CallGroupEstimate, Completeness, StageUsageEstimate, UsageEstimate
from .errors import MissingRuleError, UnboundedEstimateError
from .metrics import ContentFamily, ContentMetrics, RequestOverheads
from .profiles import (
    ESTIMATOR_ID,
    ESTIMATOR_VERSION,
    RULESET_VERSION,
    TOKEN_RULES,
    OutputProfile,
    output_profile,
)
from .request import CallKind, EstimationRequest, StageInput

#: Output profiles keyed by id. Every one is a heuristic and says so.
DEFAULT_OUTPUT_PROFILES: dict[str, OutputProfile] = {
    p.profile_id: p for p in (
        output_profile(
            "default_short", best=64, expected=256, worst=1024,
            rationale="a short answer or a small edit — the common case for one call",
            limitations=["not measured against this system's own output"]),
        output_profile(
            "code_patch", best=128, expected=800, worst=4096,
            rationale=("a SEARCH/REPLACE patch or a rewritten module; the worst case "
                       "assumes a full-file rewrite rather than a hunk"),
            limitations=["scales with file size, which this profile does not see"]),
        output_profile(
            "document", best=512, expected=2048, worst=8192,
            rationale="a written document or report section",
            limitations=["length targets vary widely and are not modelled"]),
        output_profile(
            "structured_json", best=64, expected=512, worst=2048,
            rationale=("a JSON response against a fixed schema; bounded by the schema "
                       "rather than by the prompt"),
            limitations=["a strict schema can force retries that this does not model"]),
        output_profile(
            "analysis", best=256, expected=1200, worst=4096,
            rationale="a reasoned analysis or review with findings",
            limitations=["depth is a plan choice, not a property of the input"]),
        output_profile(
            "none", best=0, expected=0, worst=0,
            rationale="a stage that produces no model output — human work, or a read",
            limitations=[]),
    )
}


class UsageEstimator:
    """Deterministic, offline, stateless. Same request in, same estimate out."""

    def __init__(self, output_profiles: Optional[dict[str, OutputProfile]] = None,
                 token_rules=None) -> None:
        self._profiles = dict(output_profiles or DEFAULT_OUTPUT_PROFILES)
        self._rules = dict(token_rules or TOKEN_RULES)

    # --- rule resolution: no substitution, ever ---
    def _rule(self, family: ContentFamily):
        rule = self._rules.get(family)
        if rule is None:
            raise MissingRuleError("token rule", family.value)
        return rule

    def _output_profile(self, profile_id: str) -> OutputProfile:
        profile = self._profiles.get(profile_id)
        if profile is None:
            raise MissingRuleError("output profile", profile_id)
        return profile

    # --- input side ---
    def _input_band(self, bodies: list[ContentMetrics],
                    overheads: RequestOverheads) -> tuple[Band, list[str], int]:
        """Tokens for one call's prompt, plus the families used and unclassified count.

        Each body is converted by *its own* family rule. A single multiplier across
        mixed content is the defect this module replaces.
        """
        best = expected = worst = 0
        families: list[str] = []
        unclassified = 0

        for body in bodies:
            rule = self._rule(body.family)
            families.append(body.family.value)
            if body.family is ContentFamily.UNKNOWN and not body.is_empty:
                unclassified += 1
            best += rule.tokens_for(body.code_points, best=True)
            expected += rule.tokens_for(body.code_points)
            worst += rule.tokens_for(body.code_points, worst=True)

        if overheads.total_code_points:
            rule = self._rule(overheads.family)
            families.append(overheads.family.value)
            best += rule.tokens_for(overheads.total_code_points, best=True)
            expected += rule.tokens_for(overheads.total_code_points)
            worst += rule.tokens_for(overheads.total_code_points, worst=True)

        return Band(best=best, expected=expected, worst=worst), families, unclassified

    # --- stage ---
    def estimate_stage(self, stage: StageInput) -> StageUsageEstimate:
        """Decompose one stage into call groups. Raises rather than guessing."""
        if stage.has_unbounded_retries:
            raise UnboundedEstimateError(
                stage.stage_id,
                "max_retries is None; an unbounded retry count has no worst case")

        per_call_input, families, unclassified = self._input_band(
            stage.inputs, stage.overheads)

        profile = self._output_profile(stage.output_profile_id).capped(
            stage.output_cap_tokens)
        # Output scales with how many artefacts the stage produces, not with prompt size.
        per_call_output = Band(
            best=profile.best_output_tokens,
            expected=profile.expected_output_tokens,
            worst=profile.worst_output_tokens,
        ).scaled(max(1, stage.artifact_count))

        warnings: list[str] = []
        assumptions: list[str] = []
        partial = False

        if unclassified:
            partial = True
            warnings.append(
                f"{unclassified} content body/bodies were unclassified and priced with "
                "the pessimistic UNKNOWN rule (1 token per character at worst)")

        if stage.output_cap_tokens is None and profile.profile_id != "none":
            assumptions.append(
                f"no explicit output cap; worst case bounded by profile "
                f"{profile.profile_id!r} at {profile.worst_output_tokens} tokens/call")

        groups: list[CallGroupEstimate] = []

        if stage.performed_by_human:
            # A human stage costs no model tokens unless the plan says its output is
            # reviewed. Human assistance is not assumed to be free of model work.
            assumptions.append(
                f"performed by a human ({stage.human_minutes} min); model tokens are "
                "counted only for a stated review pass")
            if stage.human_output_needs_review and stage.primary_calls:
                groups.append(CallGroupEstimate(
                    call_kind=CallKind.VERIFIER,
                    calls=Band.flat(stage.primary_calls),
                    input_tokens=per_call_input.scaled(stage.primary_calls),
                    output_tokens=per_call_output.scaled(stage.primary_calls),
                ))
            else:
                warnings.append(
                    "human-performed stage with no review pass: model cost is zero, "
                    "and the quality risk of unreviewed human output is not modelled")
        elif stage.primary_calls:
            groups.append(CallGroupEstimate(
                call_kind=CallKind.PRIMARY,
                calls=Band.flat(stage.primary_calls),
                input_tokens=per_call_input.scaled(stage.primary_calls),
                output_tokens=per_call_output.scaled(stage.primary_calls),
            ))

        # Retries: best case none happen, worst case all budgeted ones do. Expected
        # takes half, rounded down — a deliberate, stated heuristic, not a measurement.
        retries = stage.max_retries or 0
        if retries and not stage.performed_by_human:
            groups.append(CallGroupEstimate(
                call_kind=CallKind.RETRY,
                calls=Band(best=0, expected=retries // 2, worst=retries),
                input_tokens=Band(best=0,
                                  expected=per_call_input.expected * (retries // 2),
                                  worst=per_call_input.worst * retries),
                output_tokens=Band(best=0,
                                   expected=per_call_output.expected * (retries // 2),
                                   worst=per_call_output.worst * retries),
            ))
            assumptions.append(
                f"retry allowance {retries}/call: best assumes none fire, expected "
                f"assumes {retries // 2}, worst assumes all")

        # Verification passes are planned, so they happen in every case.
        if stage.verification_rounds:
            groups.append(CallGroupEstimate(
                call_kind=CallKind.VERIFIER,
                calls=Band.flat(stage.verification_rounds),
                input_tokens=per_call_input.scaled(stage.verification_rounds),
                output_tokens=per_call_output.scaled(stage.verification_rounds),
            ))

        # Rework is conditional on a verification failing.
        rework = stage.max_rework_rounds
        if rework:
            groups.append(CallGroupEstimate(
                call_kind=CallKind.REPAIR,
                calls=Band(best=0, expected=rework // 2, worst=rework),
                input_tokens=Band(best=0,
                                  expected=per_call_input.expected * (rework // 2),
                                  worst=per_call_input.worst * rework),
                output_tokens=Band(best=0,
                                   expected=per_call_output.expected * (rework // 2),
                                   worst=per_call_output.worst * rework),
            ))
            assumptions.append(
                f"rework allowance {rework}: best assumes verification passes first time")

        if not groups:
            groups.append(CallGroupEstimate(
                call_kind=CallKind.PRIMARY, calls=Band.zero(),
                input_tokens=Band.zero(), output_tokens=Band.zero()))

        return StageUsageEstimate(
            stage_id=stage.stage_id,
            kind=stage.kind,
            groups=groups,
            token_rule_families=sorted(set(families)),
            output_profile_id=profile.profile_id,
            assumptions=assumptions,
            warnings=warnings,
            human_minutes=stage.human_minutes,
            blocking=stage.blocking,
            parallelizable=stage.parallelizable,
            partial=partial,
        )

    # --- request ---
    def estimate(self, request: EstimationRequest) -> UsageEstimate:
        """Estimate a whole request. Totals derive from the stages."""
        stages = [self.estimate_stage(s) for s in request.stages]

        fully_specified = sum(1 for s in stages if not s.partial)
        unclassified = sum(
            1 for stage in request.stages for body in stage.inputs
            if body.family is ContentFamily.UNKNOWN and not body.is_empty)

        questions = [
            ClarifyingQuestion(
                question_id=f"missing:{name}",
                question=f"what is the value of {name!r}?",
                blocking=True,
                why_it_matters="the estimate is partial without it")
            for name in request.missing_inputs
        ]

        completeness = Completeness(
            stages_total=len(stages),
            stages_fully_specified=fully_specified,
            unclassified_content_bodies=unclassified,
            missing_inputs=list(request.missing_inputs),
            open_questions=questions,
        )

        warnings = [w for s in stages for w in s.warnings]
        assumptions = list(request.stated_assumptions)
        limitations = [
            "every coefficient is a heuristic; none has been compared with an actual",
            "confidence is UNKNOWN by construction and completeness is not a substitute",
        ]

        if request.expects_cache_hit:
            warnings.append(
                "the request expects a cache hit, but no cache rate is known for any "
                "model — caching is not reflected in this estimate")
        if not request.shares_context_between_calls:
            assumptions.append(
                "context is not shared between calls; repeated content is counted "
                "in full for every call")

        return UsageEstimate(
            request_id=request.request_id,
            scope_id=request.scope_id,
            plan_id=request.plan_id,
            plan_version=request.plan_version,
            plan_hash=request.plan_hash,
            mode=request.mode.value,
            estimator_id=ESTIMATOR_ID,
            estimator_version=ESTIMATOR_VERSION,
            ruleset_version=RULESET_VERSION,
            request_hash=request_hash(request),
            stages=stages,
            completeness=completeness,
            confidence=ConfidenceRange(
                level=Confidence.UNKNOWN,
                basis=("rules-based heuristics with no calibration against actuals; "
                       "see docs/planner/ESTIMATOR_P1B.md"),
                n_observations=0),
            assumptions=assumptions,
            warnings=warnings,
            limitations=limitations,
            partial=bool(request.missing_inputs) or fully_specified != len(stages),
            unbounded=False,
        )


def request_hash(request: EstimationRequest) -> str:
    """Full 64-hex SHA-256 of the request. Two identical requests hash identically."""
    return full_sha256(request.model_dump_json())
