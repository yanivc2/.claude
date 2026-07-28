"""P1b: rules-based usage estimation, cost projection, and the time refusal.

Pure and offline. No network, no clock, no filesystem reads by the estimator itself.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from meta_orchestrator.planner.contracts.estimates import Confidence
from meta_orchestrator.planner.contracts.plan import ExecutionMode
from meta_orchestrator.planner.contracts.scope import StageKind
from meta_orchestrator.planner.estimation import (
    ALLOWED_BASES_P1B,
    DEFAULT_OUTPUT_PROFILES,
    ESTIMATOR_ID,
    ESTIMATOR_VERSION,
    RULESET_VERSION,
    TOKEN_RULES,
    Band,
    CallKind,
    ContentFamily,
    ContentMetrics,
    CostProjection,
    EstimateProjector,
    EstimationRequest,
    MissingRuleError,
    RequestOverheads,
    RuleBasis,
    StageInput,
    UnavailableTimeEstimator,
    UnboundedEstimateError,
    UsageEstimator,
    output_profile,
    request_hash,
)
from meta_orchestrator.planner.pricing import CostCalculator, PriceTrust

CODE, HEB, LAT = (ContentFamily.SOURCE_CODE, ContentFamily.PROSE_HEBREW,
                  ContentFamily.PROSE_LATIN)
JSON_, UNK = ContentFamily.STRUCTURED_DATA, ContentFamily.UNKNOWN


@pytest.fixture
def est() -> UsageEstimator:
    return UsageEstimator()


def _stage(**over) -> StageInput:
    base = dict(stage_id="s1", kind=StageKind.GENERATE,
                inputs=[ContentMetrics(family=LAT, code_points=4000, utf8_bytes=4000)],
                primary_calls=1, max_retries=0, output_profile_id="default_short")
    base.update(over)
    return StageInput(**base)


def _request(stages=None, **over) -> EstimationRequest:
    base = dict(request_id="r1", scope_id="sc1", plan_id="p1", plan_version=1,
                plan_hash="h1", mode=ExecutionMode.AUTOMATIC,
                stages=stages or [_stage()])
    base.update(over)
    return EstimationRequest(**base)


# --------------------------------------------------------------------------- #
# Bands — the invariant everything rests on
# --------------------------------------------------------------------------- #

def test_band_enforces_best_expected_worst():
    with pytest.raises(ValueError, match="best <= expected <= worst"):
        Band(best=5, expected=1, worst=9)


def test_band_addition_and_scaling_preserve_the_invariant():
    a, b = Band(best=1, expected=2, worst=3), Band(best=10, expected=20, worst=30)
    total = a + b
    assert (total.best, total.expected, total.worst) == (11, 22, 33)
    assert a.scaled(3).worst == 9


def test_band_rejects_negative_scaling():
    with pytest.raises(ValueError, match="negative factor"):
        Band.flat(5).scaled(-1)


# --------------------------------------------------------------------------- #
# Token rules — no single multiplier
# --------------------------------------------------------------------------- #

def test_every_rule_is_declared_heuristic_and_carries_a_rationale():
    """P1b may not ship a coefficient claiming a provenance it does not have."""
    for family, rule in TOKEN_RULES.items():
        assert rule.basis is RuleBasis.HEURISTIC, family
        assert rule.rationale.strip()
    assert ALLOWED_BASES_P1B == frozenset({RuleBasis.HEURISTIC})


@pytest.mark.parametrize("basis", [RuleBasis.HISTORICAL_AVERAGE, RuleBasis.CALIBRATED,
                                   RuleBasis.LEARNED])
def test_a_non_heuristic_rule_is_rejected_in_p1b(basis):
    from meta_orchestrator.planner.estimation.profiles import TokenRule

    with pytest.raises(ValueError, match="not permitted in"):
        TokenRule(family=LAT, basis=basis, sparse_cp_per_token="4",
                  expected_cp_per_token="3", dense_cp_per_token="2", rationale="x")


def test_hebrew_is_priced_denser_than_english():
    """The core reason a single chars//4 multiplier is wrong."""
    heb, lat = TOKEN_RULES[HEB], TOKEN_RULES[LAT]
    assert heb.tokens_for(1000) > lat.tokens_for(1000)
    # Roughly a factor of two on the expected ratio — not a rounding difference.
    assert heb.tokens_for(1000) >= 2 * lat.tokens_for(1000) - 1


def test_code_and_json_are_denser_than_english_prose():
    lat = TOKEN_RULES[LAT].tokens_for(10_000)
    assert TOKEN_RULES[CODE].tokens_for(10_000) > lat
    assert TOKEN_RULES[JSON_].tokens_for(10_000) > lat


def test_unknown_content_uses_the_pessimistic_rule():
    """Guessing a friendlier ratio for unclassified text is how estimates understate."""
    assert TOKEN_RULES[UNK].tokens_for(1000, worst=True) == 1000   # 1 token/char
    assert TOKEN_RULES[UNK].tokens_for(1000) >= TOKEN_RULES[LAT].tokens_for(1000)


def test_token_conversion_rounds_up():
    """A partial token is still billed."""
    assert TOKEN_RULES[LAT].tokens_for(1) == 1
    assert TOKEN_RULES[LAT].tokens_for(0) == 0


def test_worst_ratio_yields_more_tokens_than_best():
    rule = TOKEN_RULES[CODE]
    assert (rule.tokens_for(10_000, worst=True) > rule.tokens_for(10_000)
            > rule.tokens_for(10_000, best=True))


def test_each_content_body_uses_its_own_rule(est):
    """Mixed content must not collapse to one ratio."""
    mixed = est.estimate(_request([_stage(inputs=[
        ContentMetrics(family=LAT, code_points=1000, utf8_bytes=1000),
        ContentMetrics(family=HEB, code_points=1000, utf8_bytes=2000),
    ])]))
    only_latin = est.estimate(_request([_stage(inputs=[
        ContentMetrics(family=LAT, code_points=2000, utf8_bytes=2000)])]))
    assert mixed.input_tokens.expected > only_latin.input_tokens.expected


# --------------------------------------------------------------------------- #
# Content metrics
# --------------------------------------------------------------------------- #

def test_bytes_cannot_be_below_code_points():
    with pytest.raises(ValueError, match="at least one byte"):
        ContentMetrics(family=LAT, code_points=100, utf8_bytes=50)


def test_hebrew_shows_two_bytes_per_code_point():
    m = ContentMetrics(family=HEB, code_points=1000, utf8_bytes=2000)
    assert m.bytes_per_code_point == 2.0


def test_repeated_context_cannot_exceed_the_content():
    with pytest.raises(ValueError, match="cannot exceed"):
        ContentMetrics(family=LAT, code_points=100, repeated_context_code_points=200)


def test_novel_code_points_exclude_the_repeated_part():
    m = ContentMetrics(family=LAT, code_points=1000, repeated_context_code_points=400)
    assert m.novel_code_points == 600


def test_repeated_context_is_counted_in_every_call(est):
    """Shared context is cheaper only with caching, and no cache rate is known."""
    e = est.estimate(_request([_stage(
        inputs=[ContentMetrics(family=LAT, code_points=4000,
                               repeated_context_code_points=3000)],
        primary_calls=3)]))
    single = est.estimate(_request([_stage(primary_calls=1)]))
    assert e.input_tokens.expected == single.input_tokens.expected * 3


def test_overheads_are_added_to_every_call(est):
    with_overhead = est.estimate(_request([_stage(
        overheads=RequestOverheads(system_prompt_code_points=2000,
                                   tool_schema_code_points=1000))]))
    without = est.estimate(_request([_stage()]))
    assert with_overhead.input_tokens.expected > without.input_tokens.expected


# --------------------------------------------------------------------------- #
# Output — not a function of input
# --------------------------------------------------------------------------- #

def test_output_does_not_grow_with_input_size(est):
    """A short question about a huge repository does not produce a long answer."""
    small = est.estimate(_request([_stage(
        inputs=[ContentMetrics(family=CODE, code_points=1_000)])]))
    huge = est.estimate(_request([_stage(
        inputs=[ContentMetrics(family=CODE, code_points=1_000_000)])]))
    assert huge.input_tokens.expected > 100 * small.input_tokens.expected
    assert huge.output_tokens == small.output_tokens


def test_output_scales_with_artifact_count(est):
    one = est.estimate(_request([_stage(artifact_count=1)]))
    three = est.estimate(_request([_stage(artifact_count=3)]))
    assert three.output_tokens.expected == one.output_tokens.expected * 3


def test_an_output_cap_bounds_the_worst_case(est):
    capped = est.estimate(_request([_stage(output_profile_id="document",
                                           output_cap_tokens=100)]))
    assert capped.output_tokens.worst <= 100


def test_a_cap_above_the_profile_does_not_inflate_it(est):
    profile = DEFAULT_OUTPUT_PROFILES["default_short"]
    e = est.estimate(_request([_stage(output_cap_tokens=999_999)]))
    assert e.output_tokens.worst == profile.worst_output_tokens


def test_a_zero_output_stage_costs_no_output_tokens(est):
    e = est.estimate(_request([_stage(output_profile_id="none")]))
    assert e.output_tokens == Band.zero()


def test_an_unknown_output_profile_fails_closed(est):
    with pytest.raises(MissingRuleError, match="output profile"):
        est.estimate(_request([_stage(output_profile_id="no-such-profile")]))


def test_output_profiles_are_all_heuristic_and_ordered():
    for profile in DEFAULT_OUTPUT_PROFILES.values():
        assert profile.basis is RuleBasis.HEURISTIC
        assert profile.best_output_tokens <= profile.expected_output_tokens \
            <= profile.worst_output_tokens
        assert profile.rationale.strip()


# --------------------------------------------------------------------------- #
# Retries and verification — visible, bounded
# --------------------------------------------------------------------------- #

def test_retries_are_a_separate_visible_line_item(est):
    e = est.estimate(_request([_stage(max_retries=4)]))
    by_kind = e.tokens_by_call_kind()
    assert CallKind.RETRY.value in by_kind
    assert by_kind[CallKind.RETRY.value].best == 0        # best case: none fire
    assert by_kind[CallKind.RETRY.value].worst > 0


def test_verification_is_a_separate_visible_line_item(est):
    e = est.estimate(_request([_stage(verification_rounds=2)]))
    assert CallKind.VERIFIER.value in e.tokens_by_call_kind()


def test_more_retries_never_lowers_the_estimate(est):
    prev = -1
    for n in (0, 1, 2, 5, 10):
        worst = est.estimate(_request([_stage(max_retries=n)])).total_tokens.worst
        assert worst > prev
        prev = worst


def test_more_verification_rounds_never_lowers_the_estimate(est):
    prev = -1
    for n in (0, 1, 3, 7):
        worst = est.estimate(_request([_stage(verification_rounds=n)])).total_tokens.worst
        assert worst > prev
        prev = worst


def test_unbounded_retries_fail_closed(est):
    """An invented finite bound looks like a limit and is not."""
    with pytest.raises(UnboundedEstimateError, match="unbounded retry"):
        est.estimate(_request([_stage(max_retries=None)]))


def test_rework_rounds_are_separate_from_retries(est):
    e = est.estimate(_request([_stage(max_retries=2, max_rework_rounds=2)]))
    kinds = e.tokens_by_call_kind()
    assert CallKind.RETRY.value in kinds and CallKind.REPAIR.value in kinds


# --------------------------------------------------------------------------- #
# Stages and aggregation
# --------------------------------------------------------------------------- #

def test_the_total_is_the_sum_of_the_stages(est):
    e = est.estimate(_request([
        _stage(stage_id="a"),
        _stage(stage_id="b", depends_on=["a"]),
        _stage(stage_id="c", depends_on=["a"]),
    ]))
    for attr in ("input_tokens", "output_tokens"):
        summed = sum((getattr(s, attr) for s in e.stages), Band.zero())
        assert getattr(e, attr) == summed


def test_aggregation_preserves_the_band_invariant(est):
    e = est.estimate(_request([_stage(stage_id=f"s{i}", max_retries=i)
                               for i in range(5)]))
    for band in (e.input_tokens, e.output_tokens, e.total_tokens, e.calls):
        assert band.best <= band.expected <= band.worst


def test_an_empty_input_stage_still_produces_a_valid_estimate(est):
    e = est.estimate(_request([_stage(inputs=[], output_profile_id="none")]))
    assert e.input_tokens == Band.zero()
    assert e.total_tokens == Band.zero()


def test_a_request_rejects_an_unknown_dependency():
    with pytest.raises(ValueError, match="depends on unknown"):
        _request([_stage(stage_id="a", depends_on=["ghost"])])


# --------------------------------------------------------------------------- #
# Confidence and completeness — kept apart
# --------------------------------------------------------------------------- #

def test_confidence_is_always_unknown(est):
    for stages in ([_stage()], [_stage(stage_id="a"), _stage(stage_id="b")]):
        assert est.estimate(_request(stages)).confidence.level is Confidence.UNKNOWN


def test_an_estimate_cannot_be_constructed_with_a_stronger_confidence(est):
    from meta_orchestrator.planner.contracts.estimates import ConfidenceRange

    e = est.estimate(_request())
    with pytest.raises(ValueError, match="confidence must stay UNKNOWN"):
        e.model_copy(update={"confidence": ConfidenceRange(
            level=Confidence.MEDIUM, basis="feels right")}).model_validate(
                e.model_dump() | {"confidence": ConfidenceRange(
                    level=Confidence.MEDIUM, basis="feels right")})


def test_completeness_is_not_confidence(est):
    """Full input coverage says nothing about whether the range contains the truth."""
    e = est.estimate(_request())
    assert e.completeness.is_complete is True
    assert e.confidence.level is Confidence.UNKNOWN
    assert not hasattr(e.completeness, "confidence")
    assert not hasattr(e.completeness, "probability")


def test_missing_inputs_make_the_estimate_partial_with_questions(est):
    e = est.estimate(_request(missing_inputs=["repository_size", "deadline"]))
    assert e.partial is True
    assert e.completeness.is_complete is False
    assert len(e.completeness.open_questions) == 2
    assert all(q.blocking for q in e.completeness.open_questions)


def test_unclassified_content_marks_the_stage_partial(est):
    e = est.estimate(_request([_stage(
        inputs=[ContentMetrics(family=UNK, code_points=5000)])]))
    assert e.partial is True
    assert e.completeness.unclassified_content_bodies == 1
    assert any("unclassified" in w for w in e.warnings)


def test_completeness_ratio_reflects_stage_coverage(est):
    e = est.estimate(_request([
        _stage(stage_id="ok"),
        _stage(stage_id="vague", inputs=[ContentMetrics(family=UNK, code_points=10)]),
    ]))
    assert e.completeness.ratio == Decimal(1) / Decimal(2)


# --------------------------------------------------------------------------- #
# Provenance and determinism
# --------------------------------------------------------------------------- #

def test_versions_are_recorded_on_every_estimate(est):
    e = est.estimate(_request())
    assert e.estimator_id == ESTIMATOR_ID
    assert e.estimator_version == ESTIMATOR_VERSION
    assert e.ruleset_version == RULESET_VERSION


def test_rules_used_are_traceable_in_the_result(est):
    e = est.estimate(_request([_stage(inputs=[
        ContentMetrics(family=HEB, code_points=100),
        ContentMetrics(family=CODE, code_points=100)])]))
    assert set(e.stages[0].token_rule_families) >= {HEB.value, CODE.value}
    assert e.stages[0].output_profile_id


def test_estimates_are_deterministic(est):
    r = _request()
    a, b = est.estimate(r), est.estimate(r)
    assert a.canonical_json() == b.canonical_json()
    assert a.audit_hash() == b.audit_hash()


def test_hashes_are_full_sha256(est):
    e = est.estimate(_request())
    assert len(e.audit_hash()) == 64
    assert len(e.request_hash) == 64
    assert e.display_audit_hash() == e.audit_hash()[:16]


def test_a_changed_request_changes_both_hashes(est):
    a = est.estimate(_request([_stage(max_retries=1)]))
    b = est.estimate(_request([_stage(max_retries=2)]))
    assert a.request_hash != b.request_hash
    assert a.audit_hash() != b.audit_hash()


def test_request_hash_is_stable_for_an_identical_request():
    assert request_hash(_request()) == request_hash(_request())


def test_assumptions_and_plan_binding_survive_into_the_estimate(est):
    e = est.estimate(_request(stated_assumptions=["repo is already cloned"]))
    assert "repo is already cloned" in e.assumptions
    assert e.plan_hash == "h1" and e.plan_version == 1


# --------------------------------------------------------------------------- #
# Execution modes
# --------------------------------------------------------------------------- #

def test_automatic_mode_counts_every_model_stage(est):
    e = est.estimate(_request([
        _stage(stage_id="gen", max_retries=1),
        _stage(stage_id="verify", kind=StageKind.VERIFY, verification_rounds=1,
               depends_on=["gen"]),
    ], mode=ExecutionMode.AUTOMATIC))
    assert e.total_tokens.expected > 0
    assert e.human_minutes == 0


def test_human_assisted_saving_requires_the_plan_to_declare_it(est):
    """A human stage with no review pass costs no model tokens — and says so."""
    auto = est.estimate(_request([_stage(stage_id="research", primary_calls=1)]))
    human = est.estimate(_request([_stage(
        stage_id="research", primary_calls=0, performed_by_human=True,
        human_minutes=45)], mode=ExecutionMode.HUMAN_ASSISTED))
    assert human.total_tokens.expected < auto.total_tokens.expected
    assert human.human_minutes == 45
    assert any("not modelled" in w for w in human.warnings)


def test_human_effort_never_disappears_from_the_result(est):
    e = est.estimate(_request([
        _stage(stage_id="a", primary_calls=0, performed_by_human=True, human_minutes=30),
        _stage(stage_id="b", primary_calls=0, performed_by_human=True, human_minutes=15),
    ], mode=ExecutionMode.HUMAN_ASSISTED))
    assert e.human_minutes == 45


def test_human_assisted_is_not_assumed_cheaper_when_review_is_required(est):
    """Handing work to a human and then reviewing it still costs model tokens."""
    reviewed = est.estimate(_request([_stage(
        stage_id="research", primary_calls=1, performed_by_human=True,
        human_minutes=45, human_output_needs_review=True)],
        mode=ExecutionMode.HUMAN_ASSISTED))
    assert reviewed.total_tokens.expected > 0
    assert reviewed.tokens_by_call_kind()[CallKind.VERIFIER.value].expected > 0


def test_a_human_stage_making_calls_without_a_review_step_is_rejected():
    with pytest.raises(ValueError, match="without a stated review step"):
        _stage(performed_by_human=True, primary_calls=2)


def test_human_minutes_on_a_model_stage_are_rejected():
    with pytest.raises(ValueError, match="not performed by a human"):
        _stage(human_minutes=10)


def test_low_cost_plan_estimates_lower_than_automatic(est):
    """LOW_COST is a different plan, not a different multiplier on the same one."""
    auto = est.estimate(_request([_stage(
        stage_id="gen", max_retries=2, verification_rounds=2,
        output_profile_id="document")], mode=ExecutionMode.AUTOMATIC))
    low = est.estimate(_request([_stage(
        stage_id="gen", max_retries=0, verification_rounds=1,
        output_profile_id="default_short", output_cap_tokens=512)],
        mode=ExecutionMode.LOW_COST))
    assert low.total_tokens.expected < auto.total_tokens.expected
    assert low.total_tokens.worst < auto.total_tokens.worst


# --------------------------------------------------------------------------- #
# Cost projection through P1a
# --------------------------------------------------------------------------- #

def test_projection_produces_a_range_per_model(est):
    e = est.estimate(_request())
    proj = EstimateProjector().project(e, model_ids=["claude-haiku-4-5",
                                                     "claude-opus-4-8"])
    haiku = proj.for_model("claude-haiku-4-5")
    assert haiku.available
    assert haiku.range.best <= haiku.range.expected <= haiku.range.worst


def test_projection_never_blends_rates_between_models(est):
    """The G2 rule, carried through the estimator's cost path."""
    e = est.estimate(_request())
    proj = EstimateProjector().project(e, model_ids=["claude-haiku-4-5",
                                                     "claude-opus-4-8"])
    dearest = proj.dearest()
    assert dearest.model_id == "claude-opus-4-8"
    for quote in (dearest.best_quote, dearest.expected_quote, dearest.worst_quote):
        assert quote.model_id == "claude-opus-4-8"


def test_a_missing_price_does_not_destroy_the_token_estimate(est):
    e = est.estimate(_request())
    proj = EstimateProjector().project(e, model_ids=["no-such-model"])
    unavailable = proj.for_model("no-such-model")
    assert unavailable.available is False
    assert unavailable.unavailable_reason
    assert e.total_tokens.expected > 0          # the estimate is untouched


def test_a_fictional_price_projects_but_is_not_authoritative(est):
    e = est.estimate(_request())
    proj = EstimateProjector().project(e, model_ids=["mock-strong"])
    p = proj.for_model("mock-strong")
    assert p.available is True
    assert p.price_trust is PriceTrust.FICTIONAL
    assert p.authoritative_for_real_spend is False
    assert proj.billable == []


def test_billable_projections_exclude_fictional_prices(est):
    e = est.estimate(_request())
    proj = EstimateProjector().project(
        e, model_ids=["claude-haiku-4-5", "mock-weak"])
    assert [p.model_id for p in proj.billable] == ["claude-haiku-4-5"]


def test_a_partial_estimate_taints_its_projection(est):
    e = est.estimate(_request(missing_inputs=["deadline"]))
    proj = EstimateProjector().project(e, model_ids=["claude-haiku-4-5"])
    assert any("partial" in w for w in proj.for_model("claude-haiku-4-5").warnings)


def test_projection_records_the_pricing_reference(est):
    e = est.estimate(_request())
    proj = EstimateProjector().project(e, model_ids=["claude-haiku-4-5"])
    assert proj.pricing_ref == CostCalculator().pricing_ref()
    assert proj.estimate_audit_hash == e.audit_hash()


def test_cache_is_flagged_rather_than_priced(est):
    """No cache rate is known, so an expected cache hit changes nothing but the warning."""
    e = est.estimate(_request(expects_cache_hit=True))
    assert any("cache" in w for w in e.warnings)
    proj = EstimateProjector().project(e, model_ids=["claude-haiku-4-5"])
    assert proj.for_model("claude-haiku-4-5").available is True


# --------------------------------------------------------------------------- #
# Time — an explicit refusal
# --------------------------------------------------------------------------- #

def test_time_estimation_refuses_rather_than_guessing(est):
    r = _request()
    result = UnavailableTimeEstimator().estimate_time(r, est.estimate(r))
    assert result.available is False
    assert result.range is None
    assert "never measured" in result.unavailable_reason


def test_time_estimator_still_reports_structure(est):
    r = _request([
        _stage(stage_id="a"),
        _stage(stage_id="b"),
        _stage(stage_id="c", depends_on=["a", "b"]),
    ])
    result = UnavailableTimeEstimator().estimate_time(r, est.estimate(r))
    assert result.parallel_groups == [["a", "b"], ["c"]]
    assert result.critical_path[-1] == "c"


def test_time_estimator_reports_human_minutes_from_the_plan(est):
    r = _request([_stage(primary_calls=0, performed_by_human=True, human_minutes=90)])
    result = UnavailableTimeEstimator().estimate_time(r, est.estimate(r))
    assert result.human_minutes == 90


def test_the_default_time_estimator_satisfies_the_port():
    from meta_orchestrator.planner.estimation import TimeEstimatorPort

    assert isinstance(UnavailableTimeEstimator(), TimeEstimatorPort)


# --------------------------------------------------------------------------- #
# Isolation, purity, and the G1 boundary
# --------------------------------------------------------------------------- #

def _estimation_modules():
    import pathlib

    pkg = (pathlib.Path(__file__).resolve().parents[1]
           / "src" / "meta_orchestrator" / "planner" / "estimation")
    return sorted(pkg.glob("*.py"))


def test_estimation_does_not_import_the_frozen_experiment_tree():
    import ast

    offenders = []
    for path in _estimation_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                     else [node.module or ""] if isinstance(node, ast.ImportFrom)
                     else [])
            if any("experiment" in n for n in names):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []


def test_estimation_performs_no_network_or_filesystem_access():
    import ast

    banned = {"socket", "http", "httpx", "requests", "urllib", "anthropic",
              "subprocess", "sqlite3", "ssl", "asyncio", "os", "pathlib", "io"}
    offenders = []
    for path in _estimation_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names = ([a.name.split(".")[0] for a in node.names]
                     if isinstance(node, ast.Import)
                     else [(node.module or "").split(".")[0]]
                     if isinstance(node, ast.ImportFrom) else [])
            hits = banned.intersection(names)
            if hits:
                offenders.append(f"{path.name}:{node.lineno} {sorted(hits)}")
    assert offenders == []


def test_the_orchestrator_is_untouched_and_still_uses_the_old_estimator():
    """G1 is REPLACEMENT_READY, not FIXED: nothing here is wired to the runtime."""
    import inspect

    from meta_orchestrator.orchestrator import orchestrator as orch_mod

    source = inspect.getsource(orch_mod)
    assert "_estimate_io_tokens" in source           # the G2 fix is still what runs
    assert "planner.estimation" not in source
    assert "UsageEstimator" not in source


def test_no_module_falls_back_to_a_characters_over_four_heuristic():
    import ast

    for path in _estimation_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if (isinstance(node, ast.BinOp) and isinstance(node.op, ast.FloorDiv)
                    and isinstance(node.right, ast.Constant) and node.right.value == 4):
                raise AssertionError(f"{path.name}:{node.lineno} uses a //4 shortcut")


def test_no_learning_or_calibration_surface_exists():
    from meta_orchestrator.planner import estimation

    forbidden = {"calibrate", "fit", "train", "learn", "update_coefficients"}
    assert not ({n.lower() for n in estimation.__all__} & forbidden)
    assert not hasattr(UsageEstimator, "calibrate")
    assert not hasattr(UsageEstimator, "fit")


# --------------------------------------------------------------------------- #
# Worked example, kept as documentation
# --------------------------------------------------------------------------- #

def test_worked_example_hebrew_and_code(est):
    """A repair stage reading 8k of code plus 1k of Hebrew, with one retry budgeted."""
    r = _request([_stage(
        stage_id="repair", kind=StageKind.GENERATE,
        inputs=[ContentMetrics(family=CODE, code_points=8000, utf8_bytes=8000),
                ContentMetrics(family=HEB, code_points=1000, utf8_bytes=2000)],
        primary_calls=1, max_retries=2, verification_rounds=1,
        output_profile_id="code_patch", output_cap_tokens=4096)],
        candidate_model_ids=["claude-haiku-4-5", "claude-opus-4-8"])

    e = est.estimate(r)
    assert e.confidence.level is Confidence.UNKNOWN
    assert e.partial is False
    assert e.input_tokens.best < e.input_tokens.expected < e.input_tokens.worst
    assert set(e.tokens_by_call_kind()) == {"primary", "retry", "verifier"}
    # The cap is per call, and the worst case makes four: one primary, two retries,
    # one verification. So the bound is 4096 x calls.worst, exactly.
    assert e.calls.worst == 4
    assert e.output_tokens.worst == 4096 * e.calls.worst

    proj = EstimateProjector().project(e, model_ids=r.candidate_model_ids)
    haiku, opus = (proj.for_model("claude-haiku-4-5"),
                   proj.for_model("claude-opus-4-8"))
    assert opus.range.expected > haiku.range.expected
    assert all(p.authoritative_for_real_spend for p in (haiku, opus))
