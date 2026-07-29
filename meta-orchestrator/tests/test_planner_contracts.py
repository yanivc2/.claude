"""P0: Planner contract and state-machine tests.

Pure — no I/O, no network, no database, no orchestrator. These test the invariants the
contracts exist to enforce, not the shape of the dataclasses.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from meta_orchestrator.planner.contracts import (
    ALLOWED_TRANSITIONS,
    REQUIRED_EXECUTION_MODES,
    TERMINAL_STATUSES,
    ActualUsage,
    AdmitDecision,
    ApprovalDecision,
    ApprovalGrantedEvent,
    ApprovalRequest,
    ApprovalRequiredError,
    ApprovalStatus,
    BudgetOverride,
    BudgetPolicy,
    BudgetState,
    ClarifyingQuestion,
    Confidence,
    ConfidenceRange,
    CostEstimate,
    EstimateVariance,
    EstimatorVersion,
    ExecutionMode,
    ExecutionStartedEvent,
    HardBudgetCap,
    IllegalTransitionError,
    Money,
    MoneyRange,
    ObservabilityIncompleteError,
    OutcomeStatus,
    PlanStatus,
    ProjectScope,
    RawEvidence,
    StageKind,
    TokenEstimate,
    VarianceSource,
    WorkBreakdown,
    WorkItem,
    approval_covers_execution,
    assert_may_execute,
    assert_observability_complete,
    assert_transition,
    can_transition,
    requires_approval_record,
)

USD = "USD"


def m(v: str) -> Money:
    return Money(amount=Decimal(v), currency=USD)


# --------------------------------------------------------------------------- #
# Money — the G3 defect, encoded as tests
# --------------------------------------------------------------------------- #

def test_money_refuses_float():
    """A cap enforced against binary float is a cap that rounding can cross."""
    with pytest.raises(TypeError):
        Money(amount=0.1, currency=USD)
    with pytest.raises(TypeError):
        m("1").__mul__(2.5)


def test_money_arithmetic_is_exact():
    total = m("0.1") + m("0.2")
    assert total.amount == Decimal("0.3")          # 0.30000000000000004 as float


def test_money_refuses_to_mix_currencies():
    with pytest.raises(ValueError, match="no conversion is defined"):
        m("1") + Money(amount=Decimal("1"), currency="ILS")


def test_money_rejects_malformed_currency():
    for bad in ("usd", "US", "USDD", "12"):
        with pytest.raises(ValueError):
            Money(amount=Decimal("1"), currency=bad)


def test_money_range_must_be_ordered():
    with pytest.raises(ValueError, match="best <= expected <= worst"):
        MoneyRange(best=m("5"), expected=m("1"), worst=m("9"))


# --------------------------------------------------------------------------- #
# Confidence — no unearned certainty
# --------------------------------------------------------------------------- #

def test_confidence_requires_a_stated_basis():
    with pytest.raises(ValueError, match="must say what the confidence rests on"):
        ConfidenceRange(level=Confidence.LOW, basis="   ")


def test_high_confidence_requires_enough_observations():
    """§2 measured an effect at n=8 and could not distinguish it from noise."""
    with pytest.raises(ValueError, match="needs >= 30 observations"):
        ConfidenceRange(level=Confidence.HIGH, basis="feels right", n_observations=8)
    ok = ConfidenceRange(level=Confidence.HIGH, basis="120 comparable runs",
                         n_observations=120)
    assert ok.level is Confidence.HIGH


def test_default_confidence_is_unknown_with_full_assumption_load():
    c = ConfidenceRange(basis="first sighting of this family")
    assert c.level is Confidence.UNKNOWN
    assert c.assumption_load == Decimal("1")


# --------------------------------------------------------------------------- #
# Scope and breakdown
# --------------------------------------------------------------------------- #

def _scope(**kw) -> ProjectScope:
    return ProjectScope(scope_id="s1", description="repair a failing module", **kw)


def test_blocking_questions_hold_back_estimation():
    scope = _scope(open_questions=[
        ClarifyingQuestion(question_id="q1", question="which module?", blocking=True),
        ClarifyingQuestion(question_id="q2", question="deadline?", blocking=False),
    ])
    assert scope.is_ready_for_estimate() is False
    assert [q.question_id for q in scope.blocking_questions()] == ["q1"]


def test_non_blocking_questions_do_not_hold_back_estimation():
    scope = _scope(open_questions=[
        ClarifyingQuestion(question_id="q2", question="deadline?", blocking=False)])
    assert scope.is_ready_for_estimate() is True


def test_breakdown_rejects_unknown_dependency():
    with pytest.raises(ValueError, match="depends on unknown"):
        WorkBreakdown(scope_id="s1", items=[
            WorkItem(item_id="a", kind=StageKind.ANALYZE, description="a",
                     depends_on=["ghost"])])


def test_breakdown_rejects_cycles():
    with pytest.raises(ValueError, match="cycle detected"):
        WorkBreakdown(scope_id="s1", items=[
            WorkItem(item_id="a", kind=StageKind.ANALYZE, description="a",
                     depends_on=["b"]),
            WorkItem(item_id="b", kind=StageKind.GENERATE, description="b",
                     depends_on=["a"])])


def test_breakdown_levels_group_parallelisable_work():
    wb = WorkBreakdown(scope_id="s1", items=[
        WorkItem(item_id="a", kind=StageKind.ANALYZE, description="a"),
        WorkItem(item_id="b", kind=StageKind.RESEARCH, description="b"),
        WorkItem(item_id="c", kind=StageKind.GENERATE, description="c",
                 depends_on=["a", "b"]),
    ])
    assert wb.levels() == [["a", "b"], ["c"]]


# --------------------------------------------------------------------------- #
# Plan lifecycle — the central invariant
# --------------------------------------------------------------------------- #

def test_awaiting_approval_can_never_reach_executing_directly():
    """The one shortcut that would let work start without a recorded decision."""
    assert can_transition(PlanStatus.AWAITING_APPROVAL, PlanStatus.EXECUTING) is False
    with pytest.raises(IllegalTransitionError):
        assert_transition(PlanStatus.AWAITING_APPROVAL, PlanStatus.EXECUTING)


def test_the_only_road_to_executing_is_through_approved():
    sources = [s for s, dsts in ALLOWED_TRANSITIONS.items()
               if PlanStatus.EXECUTING in dsts]
    assert sorted(s.value for s in sources) == ["APPROVED", "PAUSED_USER_INPUT"]


def test_only_approved_to_executing_demands_an_approval_record():
    assert requires_approval_record(PlanStatus.APPROVED, PlanStatus.EXECUTING) is True
    assert requires_approval_record(PlanStatus.ESTIMATED, PlanStatus.AWAITING_APPROVAL) is False


def test_editing_an_approved_plan_sends_it_back_for_re_estimation():
    assert can_transition(PlanStatus.APPROVED, PlanStatus.ESTIMATED) is True


def test_budget_pause_cannot_silently_resume():
    """Continuing past a cap needs a fresh approval, not a resume."""
    assert can_transition(PlanStatus.PAUSED_BUDGET, PlanStatus.EXECUTING) is False
    assert can_transition(PlanStatus.PAUSED_BUDGET, PlanStatus.AWAITING_APPROVAL) is True


def test_terminal_states_are_terminal():
    for status in TERMINAL_STATUSES:
        assert ALLOWED_TRANSITIONS[status] == frozenset()


def test_every_status_appears_in_the_transition_table():
    assert set(ALLOWED_TRANSITIONS) == set(PlanStatus)


def test_required_execution_modes_are_the_three_the_user_must_be_offered():
    assert REQUIRED_EXECUTION_MODES == frozenset({
        ExecutionMode.AUTOMATIC, ExecutionMode.HUMAN_ASSISTED, ExecutionMode.LOW_COST})


# --------------------------------------------------------------------------- #
# Budget
# --------------------------------------------------------------------------- #

def _cap(limit: str = "100") -> HardBudgetCap:
    return HardBudgetCap(limit=m(limit))


def test_cap_rejects_unordered_or_out_of_range_thresholds():
    with pytest.raises(ValueError, match="ascending"):
        HardBudgetCap(limit=m("10"),
                      warn_thresholds=[Decimal("0.9"), Decimal("0.5")])
    with pytest.raises(ValueError, match="strictly in"):
        HardBudgetCap(limit=m("10"), warn_thresholds=[Decimal("1.0")])


def test_spending_is_measured_against_committed_plus_actual():
    """Two concurrent calls must not both see room only one of them has."""
    state = BudgetState(plan_id="p1", policy_id="pol1",
                        committed=m("40"), actual=m("50"))
    assert state.encumbered == m("90")
    assert state.remaining(_cap()) == m("10")
    assert state.would_exceed(_cap(), m("20")) is True
    assert state.would_exceed(_cap(), m("10")) is False


def test_threshold_crossings_are_reported_cumulatively():
    state = BudgetState(plan_id="p1", policy_id="pol1",
                        committed=m("0"), actual=m("80"))
    assert state.crossed_thresholds(_cap()) == [Decimal("0.50"), Decimal("0.75")]


def test_zero_cap_reports_no_thresholds_rather_than_dividing_by_zero():
    state = BudgetState(plan_id="p1", policy_id="pol1", committed=m("0"), actual=m("0"))
    assert state.crossed_thresholds(HardBudgetCap(limit=m("0"))) == []


def test_provider_credits_are_not_a_budget():
    """An API balance is not permission to spend it."""
    policy = BudgetPolicy(policy_id="pol1", cap=_cap("10"),
                          reported_provider_credits=m("500"))
    assert policy.cap.limit == m("10")
    state = BudgetState(plan_id="p1", policy_id="pol1", committed=m("0"), actual=m("9"))
    assert state.would_exceed(policy.cap, m("5")) is True


def test_override_must_be_attributed_justified_and_upward():
    kw = dict(override_id="o1", plan_id="p1", policy_id="pol1",
              previous_limit=m("10"), approved_at="2026-07-29T00:00:00Z")
    with pytest.raises(ValueError, match="must name who approved"):
        BudgetOverride(**kw, new_limit=m("20"), approved_by="  ", justification="x")
    with pytest.raises(ValueError, match="must record why"):
        BudgetOverride(**kw, new_limit=m("20"), approved_by="yaniv", justification=" ")
    with pytest.raises(ValueError, match="must raise the limit"):
        BudgetOverride(**kw, new_limit=m("5"), approved_by="yaniv", justification="x")


def test_admit_result_treats_only_block_as_disallowed():
    from meta_orchestrator.planner.contracts import AdmitResult
    assert AdmitResult(decision=AdmitDecision.WARN_AND_ADMIT, reason="75%").allowed is True
    assert AdmitResult(decision=AdmitDecision.BLOCK, reason="over cap").allowed is False


# --------------------------------------------------------------------------- #
# Approval
# --------------------------------------------------------------------------- #

def _request(**kw) -> ApprovalRequest:
    base = dict(
        request_id="r1", plan_id="p1", plan_version=1, plan_hash="h1",
        summary="repair the module", mode=ExecutionMode.AUTOMATIC,
        expected_cost=m("10"), worst_reasonable_cost=m("25"), proposed_cap=m("30"),
        expected_duration_ms=1000, worst_duration_ms=5000,
        confidence_basis="3 comparable runs")
    base.update(kw)
    return ApprovalRequest(**base)


def _decision(**kw) -> ApprovalDecision:
    base = dict(
        decision_id="d1", request_id="r1", plan_id="p1", plan_version=1,
        plan_hash="h1", estimator_ref="rules-v1@1.0.0", status=ApprovalStatus.APPROVED,
        approved_by="yaniv", decided_at="2026-07-29T00:00:00Z",
        approved_cap=m("30"), approved_mode=ExecutionMode.AUTOMATIC)
    base.update(kw)
    return ApprovalDecision(**base)


def test_request_rejects_a_cap_below_the_expected_cost():
    with pytest.raises(ValueError, match="guarantee a mid-run halt"):
        _request(proposed_cap=m("5"))


def test_request_rejects_incoherent_bounds():
    with pytest.raises(ValueError, match="worst reasonable cost cannot be below"):
        _request(worst_reasonable_cost=m("1"))


def test_rejection_must_record_a_reason():
    with pytest.raises(ValueError, match="must record why"):
        _decision(status=ApprovalStatus.REJECTED, reason="")


def _covers(decision: ApprovalDecision, **over) -> bool:
    kw = dict(plan_id="p1", plan_version=1, plan_hash="h1",
              mode=ExecutionMode.AUTOMATIC, projected_cost=m("10"))
    kw.update(over)
    return decision.covers(**kw)


def test_approval_covers_the_exact_run_it_was_granted_for():
    assert _covers(_decision()) is True


def test_approval_does_not_survive_an_edited_plan():
    assert _covers(_decision(), plan_hash="h2") is False
    assert _covers(_decision(), plan_version=2) is False


def test_approval_does_not_transfer_to_another_mode_or_plan():
    assert _covers(_decision(), mode=ExecutionMode.LOW_COST) is False
    assert _covers(_decision(), plan_id="p2") is False


def test_approval_does_not_cover_a_projection_above_the_approved_cap():
    assert _covers(_decision(), projected_cost=m("31")) is False
    assert _covers(_decision(), projected_cost=m("30")) is True


def test_revoked_and_pending_decisions_never_cover():
    assert _covers(_decision(status=ApprovalStatus.REVOKED, reason="withdrawn")) is False
    assert _covers(_decision(status=ApprovalStatus.PENDING)) is False


def test_expiry_is_evaluated_against_injected_time():
    d = _decision(valid_until="2026-07-29T12:00:00Z")
    assert d.is_effective(now="2026-07-29T11:00:00Z") is True
    assert d.is_effective(now="2026-07-29T13:00:00Z") is False
    with pytest.raises(ValueError, match="pass `now`"):
        d.is_effective()


def test_execution_fails_closed_without_any_decision():
    with pytest.raises(ApprovalRequiredError, match="no approval decision on record"):
        assert_may_execute(None, plan_id="p1", plan_version=1, plan_hash="h1",
                           mode=ExecutionMode.AUTOMATIC, projected_cost=m("10"))


def test_execution_is_blocked_when_the_decision_does_not_cover_the_run():
    with pytest.raises(ApprovalRequiredError, match="does not cover this run"):
        assert_may_execute(_decision(), plan_id="p1", plan_version=1, plan_hash="EDITED",
                           mode=ExecutionMode.AUTOMATIC, projected_cost=m("10"))


def test_execution_is_permitted_when_the_decision_covers_the_run():
    assert_may_execute(_decision(), plan_id="p1", plan_version=1, plan_hash="h1",
                       mode=ExecutionMode.AUTOMATIC, projected_cost=m("10"))


# --------------------------------------------------------------------------- #
# Actuals and observability — the §2 closeout requirement
# --------------------------------------------------------------------------- #

def _evidence(**kw) -> RawEvidence:
    base = dict(raw_response='{"ok":true}', raw_response_sha256="abc123",
                content_blocks=[{"type": "text"}], parser_input='{"ok":true}',
                stop_reason="end_turn", parser_version="p-1")
    base.update(kw)
    return RawEvidence(**base)


def _usage(**kw) -> ActualUsage:
    base = dict(usage_id="u1", plan_id="p1", model_id="claude-haiku-4-5",
                provider="anthropic", calls=1, cost=m("0.01"),
                status=OutcomeStatus.SUCCEEDED, evidence=_evidence())
    base.update(kw)
    return ActualUsage(**base)


@pytest.mark.parametrize("field", ["raw_response", "raw_response_sha256",
                                   "parser_input", "stop_reason", "parser_version"])
def test_each_mandatory_evidence_field_is_enforced(field):
    with pytest.raises(ValueError, match="is mandatory"):
        _evidence(**{field: "  "})


def test_evidence_requires_the_ordered_content_blocks():
    with pytest.raises(ValueError, match="content_blocks"):
        _evidence(content_blocks=[])


def test_a_call_that_reached_the_provider_must_carry_its_evidence():
    """The Gate-A failure could not be localised because this was not enforced."""
    with pytest.raises(ValueError, match="requires RawEvidence"):
        _usage(evidence=None)


def test_a_call_blocked_before_send_legitimately_has_no_evidence():
    u = _usage(status=OutcomeStatus.ABORTED_BUDGET, calls=0, evidence=None)
    assert u.evidence is None


def test_observability_check_blocks_rather_than_warns():
    with pytest.raises(ObservabilityIncompleteError):
        assert_observability_complete(
            _usage(status=OutcomeStatus.ABORTED_APPROVAL, calls=0, evidence=None))
    assert_observability_complete(_usage())


def test_ambiguous_is_a_distinct_outcome_from_failure():
    """A possibly-billed call is not a clean failure and is never auto-retried."""
    assert OutcomeStatus.AMBIGUOUS is not OutcomeStatus.FAILED
    assert _usage(status=OutcomeStatus.AMBIGUOUS).status is OutcomeStatus.AMBIGUOUS


# --------------------------------------------------------------------------- #
# Variance
# --------------------------------------------------------------------------- #

def _variance(**kw) -> EstimateVariance:
    base = dict(plan_id="p1", plan_version=1, estimator_ref="rules-v1@1.0.0",
                task_family="code_repair",
                estimated_input_tokens=1000, actual_input_tokens=1200,
                estimated_output_tokens=500, actual_output_tokens=700,
                estimated_cost=m("10"), actual_cost=m("13"),
                estimated_duration_ms=1000, actual_duration_ms=1500,
                estimated_retries=1, actual_retries=2,
                estimated_verification_rounds=1, actual_verification_rounds=1)
    base.update(kw)
    return EstimateVariance(**base)


def test_variance_percentages_are_exact():
    v = _variance()
    assert v.cost_delta == m("3")
    assert v.cost_variance_pct() == Decimal("30")
    assert v.duration_variance_pct() == Decimal("50")


def test_zero_estimate_yields_none_not_infinity():
    assert _variance(estimated_cost=m("0")).cost_variance_pct() is None
    assert _variance(estimated_duration_ms=0).duration_variance_pct() is None


def test_a_classified_variance_must_be_explained():
    with pytest.raises(ValueError, match="must carry its explanation"):
        _variance(variance_source=VarianceSource.RETRIES, explanation="")


def test_apparatus_failures_are_excluded_from_calibration():
    """§2: 19/32 primary cells produced no valid patch — that measured the harness."""
    v = _variance(variance_source=VarianceSource.APPARATUS,
                  explanation="harness produced no valid patch")
    assert v.is_usable_for_calibration() is False


def test_unclassified_variances_are_excluded_from_calibration():
    assert _variance().is_usable_for_calibration() is False


def test_a_classified_explained_variance_is_usable():
    v = _variance(variance_source=VarianceSource.RETRIES,
                  explanation="two retries instead of one")
    assert v.is_usable_for_calibration() is True


# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #

def test_execution_event_must_point_back_at_its_approval():
    granted = ApprovalGrantedEvent(
        plan_id="p1", plan_version=1, plan_hash="h1", decision_id="d1",
        approved_by="yaniv", approved_cap=m("30"),
        approved_mode=ExecutionMode.AUTOMATIC, occurred_at="2026-07-29T00:00:00Z")
    ok = ExecutionStartedEvent(plan_id="p1", plan_version=1, plan_hash="h1",
                               authorising_decision_id="d1",
                               occurred_at="2026-07-29T00:01:00Z")
    assert approval_covers_execution(granted, ok) is True

    forged = ExecutionStartedEvent(plan_id="p1", plan_version=1, plan_hash="h2",
                                   authorising_decision_id="d1",
                                   occurred_at="2026-07-29T00:01:00Z")
    assert approval_covers_execution(granted, forged) is False


# --------------------------------------------------------------------------- #
# Isolation from the frozen research tree
# --------------------------------------------------------------------------- #

def _contract_modules():
    import pathlib

    pkg = (pathlib.Path(__file__).resolve().parents[1]
           / "src" / "meta_orchestrator" / "planner" / "contracts")
    return sorted(pkg.glob("*.py"))


def test_contracts_do_not_import_the_frozen_experiment_tree():
    """The Planner is a new product module, not a continuation of §2.

    Parsed rather than grepped, so the prose in the docstrings — which cites
    ``experiment/s2`` on purpose — cannot fail or mask the check.
    """
    import ast

    offenders: list[str] = []
    for path in _contract_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            if any("experiment" in n for n in names):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == [], f"contracts must not import the frozen tree: {offenders}"


def test_contracts_perform_no_io_at_import_time():
    """P0 is types only: no file, network, database or subprocess module in reach."""
    import ast

    banned = {"os", "io", "socket", "sqlite3", "subprocess", "requests",
              "httpx", "anthropic", "pathlib", "urllib"}
    offenders: list[str] = []
    for path in _contract_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [(node.module or "").split(".")[0]]
            else:
                continue
            hits = banned.intersection(names)
            if hits:
                offenders.append(f"{path.name}:{node.lineno} {sorted(hits)}")
    assert offenders == [], f"contracts must stay pure: {offenders}"


def test_token_estimate_totals_every_billed_category():
    t = TokenEstimate(input_tokens=10, output_tokens=20,
                      cache_write_tokens=5, cache_read_tokens=3)
    assert t.total_tokens == 38


def test_estimator_version_must_name_its_pricing():
    with pytest.raises(ValueError, match="pricing_ref"):
        EstimatorVersion(estimator_id="rules-v1", estimator_version="1.0.0",
                         pricing_ref="  ", created_at="2026-07-29T00:00:00Z")


def test_cost_estimate_exposes_expected_and_worst_without_collapsing_the_range():
    ce = CostEstimate(
        range=MoneyRange(best=m("1"), expected=m("2"), worst=m("9")),
        confidence=ConfidenceRange(level=Confidence.LOW, basis="no comparable runs"),
        estimator=EstimatorVersion(estimator_id="rules-v1", estimator_version="1.0.0",
                                   pricing_ref="sha:abc", created_at="2026-07-29T00:00:00Z"))
    assert ce.expected == m("2")
    assert ce.worst_reasonable == m("9")
    assert ce.range.spread == m("8")
