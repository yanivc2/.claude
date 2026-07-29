"""P1c.1: governance — purpose, snapshots, binding, authorization, override, freshness.

Pure and offline. Nothing here executes, persists, or reaches the network.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from meta_orchestrator.planner.budget.reserve import (
    REAL_SPEND_BASES,
    S2_DERIVED_25_PERCENT_HEURISTIC,
    ReserveBasis,
    ReservePolicy,
)
from meta_orchestrator.planner.contracts.budget import (
    BudgetPolicy,
    BudgetState,
    HardBudgetCap,
)
from meta_orchestrator.planner.contracts.estimates import (
    Confidence,
    ConfidenceRange,
    CostEstimate,
    EstimatorVersion,
    TimeEstimate,
    TimeEstimateRange,
    TokenEstimate,
    TokenEstimateRange,
)
from meta_orchestrator.planner.contracts.money import Money, MoneyRange
from meta_orchestrator.planner.contracts.plan import (
    ExecutionMode,
    ExecutionPlan,
    StageEstimate,
)
from meta_orchestrator.planner.contracts.scope import EstimateAssumptions, StageKind
from meta_orchestrator.planner.estimation import (
    ContentFamily,
    ContentMetrics,
    EstimateProjector,
    EstimationRequest,
    StageInput,
    UsageEstimator,
)
from meta_orchestrator.planner.governance import (
    NOT_ELIGIBLE_MARKER,
    Acknowledgement,
    ApprovalBinding,
    BindingMismatchError,
    BlockedByConditionError,
    BudgetOverride,
    BudgetSnapshot,
    ConditionCode,
    ConditionSeverity,
    ExecutionAuthorization,
    GovernanceEventType,
    GovernedApprovalGate,
    GovernedBudgetGuard,
    IdempotencyConflictError,
    InvalidReservationTransitionError,
    MissingAcknowledgementError,
    OverrideOutcome,
    PlanSnapshot,
    PriceFreshnessPolicy,
    PurposeMismatchError,
    SettlementResult,
    SpendPurpose,
    SpendReservation,
    SpendReservationBook,
    SpendReservationStatus,
    StaleSnapshotError,
    UsageCeiling,
    assert_not_promotable,
    build_binding,
    check_freshness,
    severity_of,
)
from meta_orchestrator.planner.pricing import PriceTrust

NOW = "2026-07-29T12:00:00Z"
TODAY = "2026-07-29"
USD = "USD"


def m(v: str) -> Money:
    return Money(amount=Decimal(v), currency=USD)


# --------------------------------------------------------------------------- #
# Fixtures — real estimates and real projections throughout
# --------------------------------------------------------------------------- #

def _estimate(*, partial: bool = False):
    req = EstimationRequest(
        request_id="r1", scope_id="s1", plan_id="p1", plan_version=1,
        plan_hash="declared", mode=ExecutionMode.AUTOMATIC,
        missing_inputs=["deadline"] if partial else [],
        stages=[StageInput(
            stage_id="gen", kind=StageKind.GENERATE, max_retries=1,
            inputs=[ContentMetrics(family=ContentFamily.SOURCE_CODE,
                                   code_points=8000)],
            output_profile_id="code_patch", output_cap_tokens=2048)])
    return UsageEstimator().estimate(req)


def _projection(model_id: str = "claude-haiku-4-5", *, partial: bool = False):
    est = _estimate(partial=partial)
    return est, EstimateProjector().project(
        est, model_ids=[model_id]).for_model(model_id)


def _plan(**over) -> ExecutionPlan:
    ev = EstimatorVersion(estimator_id="rules-v1", estimator_version="1.0.0",
                          pricing_ref="c", created_at=NOW)
    ce = CostEstimate(range=MoneyRange(best=m("1"), expected=m("2"), worst=m("3")),
                      confidence=ConfidenceRange(level=Confidence.UNKNOWN,
                                                 basis="rules"), estimator=ev)
    tr = TokenEstimateRange(best=TokenEstimate(input_tokens=1),
                            expected=TokenEstimate(input_tokens=2),
                            worst=TokenEstimate(input_tokens=3))
    ti = TimeEstimateRange(best=TimeEstimate(compute_ms=1),
                           expected=TimeEstimate(compute_ms=2),
                           worst=TimeEstimate(compute_ms=3))
    base = dict(
        plan_id="p1", scope_id="s1", mode=ExecutionMode.AUTOMATIC, plan_version=1,
        stages=[StageEstimate(item_id="gen", kind=StageKind.GENERATE, tokens=tr,
                              cost=ce, duration=ti)],
        total_cost=ce, total_duration=ti, assumptions=EstimateAssumptions(),
        estimator=ev, model_ids=["claude-haiku-4-5"],
        deliverables=["a repaired module"], plan_hash="declared")
    base.update(over)
    return ExecutionPlan(**base)


def _policy(limit="100", **over) -> BudgetPolicy:
    base = dict(policy_id="pol1", cap=HardBudgetCap(limit=m(limit)),
                policy_hash="ph1")
    base.update(over)
    return BudgetPolicy(**base)


def _snapshot(policy=None, *, actual="0", committed="0", **over) -> BudgetSnapshot:
    policy = policy or _policy()
    return BudgetSnapshot.of(
        policy,
        BudgetState(plan_id="p1", policy_id=policy.policy_id,
                    committed=m(committed), actual=m(actual)),
        budget_id="b1", taken_at=NOW, **over)


def _admit(*, purpose=SpendPurpose.REAL_SPEND, guard=None, plan=None,
           snapshot=None, projection=None, estimate=None, as_of=TODAY):
    guard = guard or GovernedBudgetGuard()
    plan = plan or _plan()
    if projection is None:
        estimate, projection = _projection()
    snapshot = snapshot if snapshot is not None else _snapshot()
    return guard.admit(
        admission_id="a1", purpose=purpose, plan=PlanSnapshot.of(plan),
        snapshot=snapshot, projection=projection, estimate=estimate,
        cap=_policy().cap, as_of=as_of, evaluated_at=NOW)


# =========================================================================== #
# 1. Reserve default and the named opt-in
# =========================================================================== #

def test_the_reserve_default_is_none():
    """A contingency nobody chose is a contingency nobody decided on."""
    policy = ReservePolicy()
    assert policy.basis is ReserveBasis.NONE
    assert policy.policy_name == "NONE"
    assert policy.compute(expected=m("20"), worst=m("40")) == Money.zero(USD)


def test_the_guard_defaults_to_no_contingency():
    guard = GovernedBudgetGuard()
    assert guard.reserve_policy.basis is ReserveBasis.NONE
    admission = _admit(guard=guard)
    assert admission.requested.reserve == Money.zero(USD)
    assert admission.requested.total == admission.requested.quoted


def test_the_twenty_five_percent_policy_requires_an_explicit_choice():
    """It exists, it is named, and it does not arrive by itself."""
    policy = ReservePolicy.s2_derived_25_percent_heuristic()
    assert policy.policy_name == S2_DERIVED_25_PERCENT_HEURISTIC
    assert policy.compute(expected=m("20"), worst=m("40")) == m("10")
    assert ReservePolicy().policy_name != S2_DERIVED_25_PERCENT_HEURISTIC


def test_the_twenty_five_percent_rationale_names_its_foreign_origin():
    """It came from a different workload and must not read as calibrated."""
    rationale = ReservePolicy.s2_derived_25_percent_heuristic().rationale
    assert "§2" in rationale
    assert "different workload" in rationale
    assert "Heuristic" in rationale
    assert "never measured" in rationale


def test_fraction_of_expected_must_be_marked_experimental():
    with pytest.raises(ValueError, match="experimental"):
        ReservePolicy(policy_name="X", basis=ReserveBasis.FRACTION_OF_EXPECTED,
                      fraction="0.2", rationale="x")


def test_fraction_of_expected_is_not_permitted_for_real_spend():
    policy = ReservePolicy(policy_name="X", basis=ReserveBasis.FRACTION_OF_EXPECTED,
                           fraction="0.2", experimental=True, rationale="x")
    assert policy.permitted_for_real_spend() is False
    assert ReserveBasis.FRACTION_OF_EXPECTED not in REAL_SPEND_BASES

    admission = _admit(guard=GovernedBudgetGuard(policy))
    assert admission.admitted is False
    assert ConditionCode.RESERVE_MODE_NOT_PERMITTED.value in admission.blocking_codes


def test_fraction_of_expected_is_usable_in_simulation():
    policy = ReservePolicy(policy_name="X", basis=ReserveBasis.FRACTION_OF_EXPECTED,
                           fraction="0.2", experimental=True, rationale="x")
    admission = _admit(purpose=SpendPurpose.SIMULATION,
                       guard=GovernedBudgetGuard(policy))
    assert ConditionCode.RESERVE_MODE_NOT_PERMITTED.value not in admission.blocking_codes


@pytest.mark.parametrize("basis", sorted(REAL_SPEND_BASES, key=lambda b: b.value))
def test_the_permitted_real_spend_bases_are_exactly_three(basis):
    assert REAL_SPEND_BASES == frozenset({
        ReserveBasis.NONE, ReserveBasis.FIXED_AMOUNT, ReserveBasis.FRACTION_OF_WORST})


def test_changing_the_reserve_policy_changes_its_hash_and_the_admission():
    none_guard, opt_in = GovernedBudgetGuard(), GovernedBudgetGuard(
        ReservePolicy.s2_derived_25_percent_heuristic())
    assert (none_guard.reserve_policy.content_hash()
            != opt_in.reserve_policy.content_hash())
    assert (_admit(guard=none_guard).content_hash()
            != _admit(guard=opt_in).content_hash())


# =========================================================================== #
# 2. Purpose
# =========================================================================== #

def test_a_fictional_price_blocks_real_spend_and_passes_simulation():
    est, proj = _projection("mock-strong")
    real = _admit(purpose=SpendPurpose.REAL_SPEND, projection=proj, estimate=est)
    sim = _admit(purpose=SpendPurpose.SIMULATION, projection=proj, estimate=est)
    assert real.admitted is False
    assert ConditionCode.FICTIONAL_PRICE_IN_REAL_SPEND.value in real.blocking_codes
    assert sim.admitted is True


def test_simulation_artifacts_are_marked_and_real_ones_are_not():
    assert NOT_ELIGIBLE_MARKER in _admit(purpose=SpendPurpose.SIMULATION).markers
    assert _admit(purpose=SpendPurpose.REAL_SPEND).markers == []


def test_a_simulation_decision_cannot_be_promoted_to_real_spend():
    with pytest.raises(PurposeMismatchError, match="cannot authorise real spend"):
        assert_not_promotable(SpendPurpose.SIMULATION, SpendPurpose.REAL_SPEND)
    # The reverse is fine: real-spend authority covers a rehearsal.
    assert_not_promotable(SpendPurpose.REAL_SPEND, SpendPurpose.SIMULATION)


def test_a_partial_estimate_blocks_real_spend_only():
    est, proj = _projection(partial=True)
    real = _admit(purpose=SpendPurpose.REAL_SPEND, projection=proj, estimate=est)
    sim = _admit(purpose=SpendPurpose.SIMULATION, projection=proj, estimate=est)
    assert ConditionCode.PARTIAL_ESTIMATE_IN_REAL_SPEND.value in real.blocking_codes
    assert sim.admitted is True


# =========================================================================== #
# 3. Snapshots
# =========================================================================== #

def test_budget_snapshot_hash_moves_with_spend():
    a, b = _snapshot(actual="0"), _snapshot(actual="10")
    assert a.content_hash() != b.content_hash()
    assert len(a.content_hash()) == 64


@pytest.mark.parametrize("field,value", [
    ("committed", "5"), ("actual", "5"),
])
def test_every_money_field_is_part_of_the_snapshot_identity(field, value):
    base = _snapshot()
    moved = _snapshot(**{field: value})
    assert base.content_hash() != moved.content_hash()


def test_provider_credits_are_informational_and_not_part_of_the_identity():
    """Credits drift for reasons unrelated to this plan; invalidating on them would
    train everyone to re-approve reflexively."""
    plain = _snapshot(_policy())
    with_credits = _snapshot(_policy(reported_provider_credits=m("500")))
    assert with_credits.provider_credits == m("500")
    assert plain.content_hash() == with_credits.content_hash()


def test_an_effective_cap_above_the_hard_cap_needs_an_override_to_justify_it():
    with pytest.raises(ValueError, match="no approved override"):
        _snapshot(effective_cap=m("200"))
    ok = _snapshot(effective_cap=m("200"), override_ids=["o1"])
    assert ok.effective_cap == m("200")


def test_an_effective_cap_below_the_hard_cap_is_rejected():
    with pytest.raises(ValueError, match="never lower it silently"):
        _snapshot(effective_cap=m("50"))


def test_plan_snapshot_hash_is_computed_from_the_plan_not_taken_on_trust():
    snap = PlanSnapshot.of(_plan(plan_hash="a-lie"))
    assert len(snap.content_hash()) == 64
    assert snap.declared_plan_hash == "a-lie"
    assert snap.declared_hash_matches is False


def test_two_plans_declaring_the_same_hash_still_differ_if_their_content_differs():
    """The declared field cannot mask a real change."""
    a = PlanSnapshot.of(_plan(plan_hash="same"))
    b = PlanSnapshot.of(_plan(plan_hash="same", model_ids=["claude-opus-4-8"]))
    assert a.declared_plan_hash == b.declared_plan_hash
    assert a.content_hash() != b.content_hash()


@pytest.mark.parametrize("field,value", [
    ("plan_version", 2),
    ("model_ids", ["claude-opus-4-8"]),
    ("deliverables", ["something else"]),
    ("exclusions", ["no tests"]),
])
def test_changing_a_material_plan_field_changes_the_snapshot_hash(field, value):
    assert (PlanSnapshot.of(_plan()).content_hash()
            != PlanSnapshot.of(_plan(**{field: value})).content_hash())


def test_changing_a_stage_changes_the_plan_hash():
    plan = _plan()
    edited = plan.model_copy(update={"stages": [
        plan.stages[0].model_copy(update={"item_id": "renamed"})]})
    assert PlanSnapshot.of(plan).content_hash() != PlanSnapshot.of(edited).content_hash()


# =========================================================================== #
# 4. Conditions and acknowledgements
# =========================================================================== #

def test_severity_is_a_property_of_the_code_not_the_callers_choice():
    from meta_orchestrator.planner.governance import Condition

    assert severity_of(ConditionCode.BUDGET_BREACH) is ConditionSeverity.BLOCKING
    with pytest.raises(ValueError, match="cannot reclassify"):
        Condition(code=ConditionCode.BUDGET_BREACH, detail="x",
                  severity=ConditionSeverity.INFORMATIONAL)


def test_a_blocking_condition_cannot_be_acknowledged_away():
    with pytest.raises(ValueError, match="cannot be acknowledged away"):
        Acknowledgement(code=ConditionCode.BUDGET_BREACH, acknowledged_by="yaniv",
                        acknowledged_at=NOW)


@pytest.mark.parametrize("code", [
    ConditionCode.BUDGET_BREACH, ConditionCode.STALE_BUDGET_SNAPSHOT,
    ConditionCode.CURRENCY_MISMATCH, ConditionCode.UNBOUNDED_ESTIMATE,
    ConditionCode.FICTIONAL_PRICE_IN_REAL_SPEND, ConditionCode.PRICE_TOO_OLD,
])
def test_the_named_blocking_conditions_are_blocking(code):
    assert severity_of(code) is ConditionSeverity.BLOCKING


@pytest.mark.parametrize("code", [
    ConditionCode.CONFIDENCE_UNKNOWN, ConditionCode.HEURISTIC_ESTIMATOR,
    ConditionCode.PRICE_NOT_PROVIDER_VERIFIED,
    ConditionCode.NO_PRICE_FRESHNESS_POLICY,
])
def test_the_named_acknowledgeable_warnings_are_acknowledgeable(code):
    assert severity_of(code) is ConditionSeverity.ACKNOWLEDGEABLE


def test_a_real_admission_raises_the_expected_acknowledgeable_risks():
    admission = _admit()
    codes = {c.code for c in admission.conditions.acknowledgeable}
    assert ConditionCode.CONFIDENCE_UNKNOWN in codes
    assert ConditionCode.HEURISTIC_ESTIMATOR in codes
    assert ConditionCode.PRICE_NOT_PROVIDER_VERIFIED in codes


def test_approval_refuses_while_an_acknowledgement_is_missing():
    gate, request = _present()
    with pytest.raises(MissingAcknowledgementError):
        gate.approve(request=request, decision_id="d1", approved_by="yaniv",
                     decided_at=NOW, acknowledgements=[])


def test_approval_refuses_outright_when_a_blocking_condition_stands():
    est, proj = _projection("mock-strong")
    gate, request = _present(projection=proj, estimate=est)
    acks = [Acknowledgement(code=c, acknowledged_by="y", acknowledged_at=NOW)
            for c in request.required_acknowledgements]
    with pytest.raises(BlockedByConditionError, match="have to be resolved"):
        gate.approve(request=request, decision_id="d1", approved_by="y",
                     decided_at=NOW, acknowledgements=acks)


# =========================================================================== #
# 5. Freshness
# =========================================================================== #

def test_no_freshness_policy_raises_an_acknowledgeable_warning():
    code = check_freshness(PriceFreshnessPolicy(), model_id="m",
                           verified_at="2020-01-01", as_of=TODAY)
    assert code is ConditionCode.NO_PRICE_FRESHNESS_POLICY
    assert severity_of(code) is ConditionSeverity.ACKNOWLEDGEABLE


def test_an_over_age_price_is_blocked_with_no_fallback():
    policy = PriceFreshnessPolicy(maximum_price_age_days=30)
    assert check_freshness(policy, model_id="m", verified_at="2026-01-01",
                           as_of=TODAY) is ConditionCode.PRICE_TOO_OLD
    assert check_freshness(policy, model_id="m", verified_at="2026-07-20",
                           as_of=TODAY) is None


def test_a_missing_verification_date_is_blocked_when_required():
    strict = PriceFreshnessPolicy(require_verification_date=True)
    assert check_freshness(strict, model_id="m", verified_at="",
                           as_of=TODAY) is ConditionCode.PRICE_TOO_OLD


def test_an_unparseable_date_is_not_evidence_of_freshness():
    policy = PriceFreshnessPolicy(maximum_price_age_days=30)
    assert check_freshness(policy, model_id="m", verified_at="not-a-date",
                           as_of=TODAY) is ConditionCode.PRICE_TOO_OLD


def test_a_stale_price_blocks_a_real_admission():
    guard = GovernedBudgetGuard(
        freshness=PriceFreshnessPolicy(maximum_price_age_days=1))
    admission = _admit(guard=guard, as_of="2027-01-01")
    assert admission.admitted is False
    assert ConditionCode.PRICE_TOO_OLD.value in admission.blocking_codes


def test_a_fresh_price_admits_under_the_same_policy():
    guard = GovernedBudgetGuard(
        freshness=PriceFreshnessPolicy(maximum_price_age_days=3650))
    assert _admit(guard=guard).admitted is True


# =========================================================================== #
# 6. Binding
# =========================================================================== #

def _binding(**over) -> ApprovalBinding:
    est, proj = _projection()
    plan = PlanSnapshot.of(_plan())
    admission = _admit(projection=proj, estimate=est)
    binding = build_binding(admission=admission, plan=plan, estimate=est,
                            projection=proj, snapshot=_snapshot(),
                            pricing_catalog_version="cat-v1",
                            reserve_policy_hash=ReservePolicy().content_hash())
    return binding.model_copy(update=over) if over else binding


def test_a_binding_names_every_artifact_it_was_granted_against():
    from meta_orchestrator.planner.governance import BOUND_FIELDS

    binding = _binding()
    for field in BOUND_FIELDS:
        assert getattr(binding, field), f"{field} is empty"


def test_a_binding_refuses_a_display_hash():
    """Constructed, not model_copy'd — model_copy bypasses validation by design."""
    fields = _binding().model_dump()
    fields["plan_hash"] = "deadbeefdeadbeef"
    with pytest.raises(ValueError, match="full 64-hex"):
        ApprovalBinding(**fields)


def test_a_binding_refuses_an_empty_identity():
    fields = _binding().model_dump()
    fields["admission_hash"] = ""
    with pytest.raises(ValueError, match="binds nothing"):
        ApprovalBinding(**fields)


@pytest.mark.parametrize("field", [
    "estimate_audit_hash", "projection_hash", "price_card_content_hash",
    "budget_snapshot_hash", "admission_hash",
])
def test_changing_any_bound_hash_invalidates_the_approval(field):
    approved = _binding()
    current = _binding(**{field: "f" * 64})
    assert approved.diff(current) == [field]
    with pytest.raises(BindingMismatchError, match=field):
        approved.assert_covers(current)


def test_changing_the_reserve_policy_invalidates_the_approval():
    approved = _binding()
    current = _binding(
        reserve_policy_hash=ReservePolicy.s2_derived_25_percent_heuristic().content_hash())
    assert "reserve_policy_hash" in approved.diff(current)


def test_changing_the_estimator_version_invalidates_the_approval():
    approved = _binding()
    assert "estimator_version" in approved.diff(_binding(estimator_version="9.9.9"))


def test_an_unchanged_binding_still_covers():
    assert _binding().diff(_binding()) == []


# =========================================================================== #
# 7. Approval, authorization, stale state
# =========================================================================== #

def _present(*, purpose=SpendPurpose.REAL_SPEND, plan=None, projection=None,
             estimate=None, snapshot=None, guard=None):
    guard = guard or GovernedBudgetGuard()
    plan = plan or _plan()
    if projection is None:
        estimate, projection = _projection()
    snapshot = snapshot if snapshot is not None else _snapshot()
    admission = guard.admit(
        admission_id="a1", purpose=purpose, plan=PlanSnapshot.of(plan),
        snapshot=snapshot, projection=projection, estimate=estimate,
        cap=_policy().cap, as_of=TODAY, evaluated_at=NOW)
    return GovernedApprovalGate().present(
        request_id="req1", admission=admission, plan=plan,
        plan_snapshot=PlanSnapshot.of(plan), estimate=estimate,
        projection=projection, snapshot=snapshot,
        pricing_catalog_version="cat-v1",
        reserve_policy_hash=guard.reserve_policy.content_hash(), occurred_at=NOW)


def _approved(**kw):
    gate, request = _present(**kw)
    acks = [Acknowledgement(code=c, acknowledged_by="yaniv", acknowledged_at=NOW)
            for c in request.required_acknowledgements]
    gate, decision = gate.approve(request=request, decision_id="d1",
                                  approved_by="yaniv", decided_at=NOW,
                                  acknowledgements=acks)
    return gate, request, decision


def _authorise(gate, decision, *, snapshot=None, plan=None, purpose=None):
    """Rebuild the current binding under the same purpose the decision was made with.

    A binding built under a different purpose legitimately fails to cover — that is
    the point of the field — so the helper must not introduce that difference itself.
    """
    purpose = purpose or SpendPurpose.REAL_SPEND
    plan = plan or _plan()
    est, proj = _projection()
    binding = build_binding(
        admission=_admit(purpose=purpose, projection=proj, estimate=est),
        plan=PlanSnapshot.of(plan), estimate=est, projection=proj,
        snapshot=_snapshot(), pricing_catalog_version="cat-v1",
        reserve_policy_hash=ReservePolicy().content_hash())
    return gate.authorise(
        decision=decision, current_snapshot=snapshot or _snapshot(),
        current_binding=binding, authorization_id="auth1",
        purpose=purpose, plan=plan, projection=proj,
        reserve_amount=Money.zero(USD),
        usage_ceiling=UsageCeiling(max_calls=4), valid_from=NOW, issued_by="yaniv")


def test_authorization_is_a_separate_artifact_not_a_decision_id():
    gate, _, decision = _approved()
    _, auth = _authorise(gate, decision)
    assert isinstance(auth, ExecutionAuthorization)
    assert auth.authorization_id == "auth1"
    assert auth.approval_decision_id == decision.decision_id
    assert auth.permitted_model_id == "claude-haiku-4-5"
    assert auth.permitted_mode is ExecutionMode.AUTOMATIC
    assert len(auth.content_hash()) == 64


def test_a_real_spend_authorization_needs_at_least_one_usage_ceiling():
    gate, _, decision = _approved()
    with pytest.raises(ValueError, match="unlimited permission is not permission"):
        gate.authorise(
            decision=decision, current_snapshot=_snapshot(),
            current_binding=decision.binding, authorization_id="a",
            purpose=SpendPurpose.REAL_SPEND, plan=_plan(),
            projection=_projection()[1], reserve_amount=Money.zero(USD),
            usage_ceiling=UsageCeiling(), valid_from=NOW)


def test_a_stale_budget_snapshot_refuses_authorization():
    """Admission, approval, someone else spends, authorization is refused."""
    gate, _, decision = _approved()
    moved = _snapshot(actual="40")
    with pytest.raises(StaleSnapshotError, match="re-admit and re-approve"):
        _authorise(gate, decision, snapshot=moved)


def test_authorization_records_a_refusal_event():
    gate, _, decision = _approved()
    try:
        _authorise(gate, decision, snapshot=_snapshot(actual="40"))
    except StaleSnapshotError:
        pass
    kinds = [e.event_type for e in gate.events.events]
    assert GovernanceEventType.AUTHORIZATION_REFUSED in kinds


def test_a_rejected_decision_cannot_authorise():
    gate, request = _present()
    gate, decision = gate.reject(request=request, decision_id="d1", approved_by="y",
                                 decided_at=NOW, reason="too expensive")
    with pytest.raises(BlockedByConditionError, match="was a no"):
        _authorise(gate, decision)


def test_an_authorization_is_not_valid_outside_its_window():
    gate, _, decision = _approved()
    _, auth = _authorise(gate, decision)
    expiring = auth.model_copy(update={"expires_at": "2026-07-29T13:00:00Z"})
    assert expiring.is_valid_at("2026-07-29T12:30:00Z") is True
    assert expiring.is_valid_at("2026-07-29T14:00:00Z") is False


def test_a_simulation_authorization_cannot_be_used_for_real_spend():
    gate, _, decision = _approved(purpose=SpendPurpose.SIMULATION)
    _, auth = _authorise(gate, decision, purpose=SpendPurpose.SIMULATION)
    assert NOT_ELIGIBLE_MARKER in auth.markers
    with pytest.raises(PurposeMismatchError):
        auth.assert_usable_for(SpendPurpose.REAL_SPEND, now=NOW)
    auth.assert_usable_for(SpendPurpose.SIMULATION, now=NOW)


def test_the_hash_is_documented_as_not_being_a_signature():
    from meta_orchestrator.planner.governance import HASH_IS_NOT_A_SIGNATURE

    gate, _, decision = _approved()
    _, auth = _authorise(gate, decision)
    assert "NOT a cryptographic signature" in auth.note
    assert "NOT a cryptographic signature" in HASH_IS_NOT_A_SIGNATURE


# =========================================================================== #
# 8. Deliverables
# =========================================================================== #

def test_a_plan_with_no_deliverables_blocks_real_spend():
    admission = _admit(plan=_plan(deliverables=[]))
    assert ConditionCode.MISSING_DELIVERABLES.value in admission.blocking_codes


def test_a_plan_that_legitimately_produces_no_artifact_may_say_so():
    plan = _plan(deliverables=[], produces_no_artifact=True)
    gate, request = _present(plan=plan)
    assert request.is_complete is True


def test_deliverables_are_bound_into_the_plan_identity():
    assert (PlanSnapshot.of(_plan(deliverables=["a"])).content_hash()
            != PlanSnapshot.of(_plan(deliverables=["b"])).content_hash())


def test_deliverables_reach_the_approval_request():
    _, request = _present()
    assert request.deliverables == ["a repaired module"]


# =========================================================================== #
# 9. Override
# =========================================================================== #

def _override(**over) -> BudgetOverride:
    base = dict(override_id="o1", actor="yaniv", reason="the run is worth finishing",
                original_cap=m("100"), new_cap=m("150"), currency=USD,
                bound_plan_hash="a" * 64, bound_admission_hash="b" * 64,
                approval_decision_id="d-override", granted_at=NOW)
    base.update(over)
    return BudgetOverride(**base)


def test_an_override_must_be_attributed_justified_and_upward():
    with pytest.raises(ValueError, match="who granted it"):
        _override(actor="  ")
    with pytest.raises(ValueError, match="why it was needed"):
        _override(reason=" ")
    with pytest.raises(ValueError, match="must raise the ceiling"):
        _override(new_cap=m("50"))


def test_an_override_must_cite_its_own_approval():
    with pytest.raises(ValueError, match="must cite its approval"):
        _override(approval_decision_id="")


def test_an_override_is_bound_to_a_plan_and_an_admission():
    o = _override()
    assert o.applies_to(plan_hash="a" * 64, admission_hash="b" * 64) is True
    assert o.applies_to(plan_hash="c" * 64, admission_hash="b" * 64) is False


def test_an_override_bound_to_a_display_hash_is_rejected():
    with pytest.raises(ValueError, match="bound to nothing"):
        _override(bound_plan_hash="abcd1234")


def test_the_override_cascade_cannot_be_partial():
    with pytest.raises(ValueError, match="how an override becomes a bypass"):
        OverrideOutcome(override=_override(), new_snapshot_hash="c" * 64,
                        requires_new_authorization=False)


def test_an_override_changes_the_snapshot_and_therefore_the_binding():
    before = _snapshot()
    after = _snapshot(effective_cap=m("150"), override_ids=["o1"])
    assert before.content_hash() != after.content_hash()
    assert after.effective_cap == m("150")


def test_an_override_invalidates_a_prior_authorization():
    """The chain breaks at the snapshot, which is exactly the intent."""
    gate, _, decision = _approved()
    raised = _snapshot(effective_cap=m("150"), override_ids=["o1"])
    with pytest.raises(StaleSnapshotError):
        _authorise(gate, decision, snapshot=raised)


# =========================================================================== #
# 10. Reservation lifecycle and idempotency
# =========================================================================== #

def _reservation(**over) -> SpendReservation:
    base = dict(reservation_id="res1", idempotency_key="key-1",
                authorization_id="auth1", budget_id="b1", plan_id="p1",
                amount=m("10"), reserve_component=Money.zero(USD), currency=USD)
    base.update(over)
    return SpendReservation(**base)


def _book() -> SpendReservationBook:
    return SpendReservationBook(budget_id="b1", currency=USD)


def test_an_identical_retry_does_not_reserve_twice():
    book, first = _book().propose(_reservation())
    book2, second = book.propose(_reservation())
    assert second.reservation_id == first.reservation_id
    assert len(book2.reservations) == 1
    assert book2.committed == m("10")


def test_the_same_key_with_a_different_payload_fails():
    book, _ = _book().propose(_reservation())
    with pytest.raises(IdempotencyConflictError, match="different payload"):
        book.propose(_reservation(reservation_id="res2", amount=m("99")))


@pytest.mark.parametrize("first,second", [
    ("commit", "commit"),
    ("settle", "settle"),
])
def test_repeating_a_terminal_transition_fails(first, second):
    r = _reservation().commit() if first == "settle" else _reservation()
    r = r.settle(m("8")) if first == "settle" else r.commit()
    with pytest.raises(InvalidReservationTransitionError):
        (r.settle(m("8")) if second == "settle" else r.commit())


def test_release_after_settle_fails():
    r = _reservation().commit().settle(m("8"))
    with pytest.raises(InvalidReservationTransitionError, match="settled -> released"):
        r.release(reason="changed my mind")


def test_settle_after_release_fails():
    r = _reservation().release(reason="never sent")
    with pytest.raises(InvalidReservationTransitionError, match="released -> settled"):
        r.settle(m("8"))


def test_an_ambiguous_reservation_is_not_auto_released():
    r = _reservation().commit().mark_ambiguous(reason="connection dropped")
    assert r.status is SpendReservationStatus.AMBIGUOUS
    assert r.is_open is True
    book, _ = _book().propose(r)
    assert book.committed == m("10")
    assert book.has_unresolved_ambiguity is True


def test_an_ambiguous_reservation_can_only_be_settled_or_released():
    r = _reservation().commit().mark_ambiguous(reason="unknown")
    assert r.settle(m("9")).status is SpendReservationStatus.SETTLED
    assert r.release(reason="confirmed not billed").status is SpendReservationStatus.RELEASED
    with pytest.raises(InvalidReservationTransitionError):
        r.commit()


def test_an_overrun_is_recorded_and_requires_review():
    r = _reservation().commit().settle(m("14"))
    assert r.overrun == m("4")
    result = SettlementResult.of(r)
    assert result.review_required is True
    assert "review required" in result.detail


def test_settling_within_the_reservation_needs_no_review():
    result = SettlementResult.of(_reservation().commit().settle(m("7")))
    assert result.overrun is None
    assert result.review_required is False


def test_an_overrun_result_cannot_be_marked_as_needing_no_review():
    with pytest.raises(ValueError, match="same as having no cap"):
        SettlementResult(reservation_id="r", reserved=m("10"), actual=m("12"),
                         overrun=m("2"), review_required=False)


def test_an_overrun_does_not_widen_the_cap():
    """The snapshot's cap is untouched by a settlement, whatever it comes in at."""
    snapshot = _snapshot()
    book, r = _book().propose(_reservation())
    book = book.replace(r.commit().settle(m("99")))
    assert book.overruns
    assert snapshot.effective_cap == m("100")


def test_reservation_artifacts_carry_full_hashes_and_their_identities():
    r = _reservation()
    assert len(r.content_hash()) == 64
    assert len(r.payload_hash()) == 64
    payload = r.canonical_payload()
    for key in ("reservation_id", "idempotency_key", "authorization_id", "budget_id",
                "plan_id", "amount", "reserve_component", "currency", "status"):
        assert key in payload


# =========================================================================== #
# 11. Events
# =========================================================================== #

def test_the_governance_log_records_the_decision_chain():
    gate, _, decision = _approved()
    gate, _ = _authorise(gate, decision)
    kinds = [e.event_type for e in gate.events.events]
    assert kinds == [GovernanceEventType.APPROVAL_REQUESTED,
                     GovernanceEventType.APPROVAL_GRANTED,
                     GovernanceEventType.AUTHORIZATION_ISSUED]


def test_events_are_hashable_and_carry_their_subject_identities():
    gate, _, _ = _approved()
    event = gate.events.events[0]
    assert len(event.content_hash()) == 64
    assert "admission_hash" in event.subject_hashes
    assert len(gate.events.content_hash()) == 64


def test_the_event_log_hash_changes_when_an_event_is_added():
    gate, _, decision = _approved()
    before = gate.events.content_hash()
    gate, _ = _authorise(gate, decision)
    assert gate.events.content_hash() != before


def test_events_do_not_carry_prompt_content():
    """A governance log that accumulates prompts becomes the largest uncontrolled
    data store in the system."""
    gate, _, _ = _approved()
    for event in gate.events.events:
        payload = event.canonical_payload()
        assert "prompt" not in payload
        assert "raw_response" not in payload


def test_a_rejection_is_recorded_as_an_event():
    gate, request = _present()
    gate, _ = gate.reject(request=request, decision_id="d1", approved_by="y",
                          decided_at=NOW, reason="no")
    assert GovernanceEventType.APPROVAL_REJECTED in [e.event_type
                                                     for e in gate.events.events]


# =========================================================================== #
# 12. Hashing and canonical serialization
# =========================================================================== #

def test_every_governance_artifact_hashes_to_a_full_sha256():
    gate, request, decision = _approved()
    gate, auth = _authorise(gate, decision)
    est, proj = _projection()
    artifacts = [
        _snapshot(), PlanSnapshot.of(_plan()), _admit(), request, decision, auth,
        _override(), _reservation(),
        SettlementResult.of(_reservation().commit().settle(m("8"))),
        gate.events.events[0],
    ]
    for artifact in artifacts:
        digest = artifact.content_hash()
        assert len(digest) == 64, type(artifact).__name__
        assert all(c in "0123456789abcdef" for c in digest)


def test_display_hashes_are_derived_and_shorter():
    snapshot = _snapshot()
    assert snapshot.display_hash() == snapshot.content_hash()[:16]


def test_canonical_serialization_refuses_a_float():
    from meta_orchestrator.planner.governance.canonical import canonical_json

    with pytest.raises(TypeError, match="already lost precision"):
        canonical_json({"amount": 1.5})


def test_canonical_serialization_is_stable_across_key_order():
    from meta_orchestrator.planner.governance.canonical import content_hash

    assert content_hash({"a": 1, "b": 2}) == content_hash({"b": 2, "a": 1})


# =========================================================================== #
# 13. Boundaries
# =========================================================================== #

def _governance_modules():
    import pathlib

    pkg = (pathlib.Path(__file__).resolve().parents[1]
           / "src" / "meta_orchestrator" / "planner" / "governance")
    return sorted(pkg.glob("*.py"))


def test_governance_does_not_import_the_frozen_experiment_tree():
    import ast

    offenders = []
    for path in _governance_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                     else [node.module or ""] if isinstance(node, ast.ImportFrom)
                     else [])
            if any("experiment" in n for n in names):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []


def test_governance_performs_no_network_or_persistence():
    import ast

    banned = {"socket", "http", "httpx", "requests", "urllib", "anthropic",
              "subprocess", "sqlite3", "ssl", "asyncio", "os", "pathlib", "io",
              "pickle", "shelve"}
    offenders = []
    for path in _governance_modules():
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


def test_governance_reads_no_clock():
    """Every time value is injected, so the whole layer stays deterministic."""
    import ast

    offenders = []
    for path in _governance_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in ("now", "today",
                                                                 "utcnow", "time"):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []


def test_the_orchestrator_is_still_untouched():
    import inspect

    from meta_orchestrator.orchestrator import orchestrator as orch_mod

    source = inspect.getsource(orch_mod)
    for name in ("planner.governance", "GovernedBudgetGuard", "ExecutionAuthorization",
                 "planner.estimation", "planner.budget", "planner.approval"):
        assert name not in source


# =========================================================================== #
# 14. Worked example — the whole governed chain, nothing executed
# =========================================================================== #

def test_worked_example_admit_approve_authorise_reserve_settle():
    guard = GovernedBudgetGuard()                       # reserve NONE by default
    est, proj = _projection()
    plan = _plan()
    snapshot = _snapshot()

    admission = guard.admit(
        admission_id="a1", purpose=SpendPurpose.REAL_SPEND,
        plan=PlanSnapshot.of(plan), snapshot=snapshot, projection=proj,
        estimate=est, cap=_policy().cap, as_of=TODAY, evaluated_at=NOW)
    assert admission.admitted is True
    assert admission.requested.reserve == Money.zero(USD)

    gate = GovernedApprovalGate()
    gate, request = gate.present(
        request_id="req1", admission=admission, plan=plan,
        plan_snapshot=PlanSnapshot.of(plan), estimate=est, projection=proj,
        snapshot=snapshot, pricing_catalog_version="cat-v1",
        reserve_policy_hash=guard.reserve_policy.content_hash(), occurred_at=NOW)
    assert request.deliverables == ["a repaired module"]

    acks = [Acknowledgement(code=c, acknowledged_by="yaniv", acknowledged_at=NOW)
            for c in request.required_acknowledgements]
    gate, decision = gate.approve(request=request, decision_id="d1",
                                  approved_by="yaniv", decided_at=NOW,
                                  acknowledgements=acks)

    binding_now = build_binding(
        admission=admission, plan=PlanSnapshot.of(plan), estimate=est,
        projection=proj, snapshot=snapshot, pricing_catalog_version="cat-v1",
        reserve_policy_hash=guard.reserve_policy.content_hash())
    gate, auth = gate.authorise(
        decision=decision, current_snapshot=snapshot, current_binding=binding_now,
        authorization_id="auth1", purpose=SpendPurpose.REAL_SPEND, plan=plan,
        projection=proj, reserve_amount=Money.zero(USD),
        usage_ceiling=UsageCeiling(max_calls=4, max_output_tokens=8192),
        valid_from=NOW, issued_by="yaniv")

    book, reservation = SpendReservationBook(budget_id="b1", currency=USD).propose(
        SpendReservation(reservation_id="res1", idempotency_key="call-1",
                         authorization_id=auth.authorization_id, budget_id="b1",
                         plan_id=plan.plan_id, amount=auth.approved_commitment,
                         reserve_component=Money.zero(USD), currency=USD))
    book = book.replace(reservation.commit())
    settled = book.get("res1").settle(m("0.01"))
    book = book.replace(settled)

    assert book.settled == m("0.01")
    assert book.committed == Money.zero(USD)
    assert SettlementResult.of(settled).review_required is False
    assert [e.event_type for e in gate.events.events] == [
        GovernanceEventType.APPROVAL_REQUESTED,
        GovernanceEventType.APPROVAL_GRANTED,
        GovernanceEventType.AUTHORIZATION_ISSUED]
