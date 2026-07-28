"""P1c: budget admission and the approval gate.

Pure and offline. Neither component executes anything, and neither is wired to the
orchestrator.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from meta_orchestrator.planner.approval import (
    ApprovalGate,
    ApprovalLog,
    DecisionAlreadyRecordedError,
    DecisionMismatchError,
    UnknownApprovalRequestError,
    approve,
    reject,
)
from meta_orchestrator.planner.budget import (
    AdmissionReport,
    BudgetGuard,
    DoubleReconcileError,
    InsufficientBudgetError,
    NonAuthoritativePriceError,
    Reservation,
    ReservationLedger,
    ReservationStatus,
    ReserveBasis,
    ReservePolicy,
    apply_reserve,
)
from meta_orchestrator.planner.contracts.approval import ApprovalStatus
from meta_orchestrator.planner.contracts.budget import (
    AdmitDecision,
    BreachAction,
    BudgetPolicy,
    BudgetState,
    HardBudgetCap,
)
from meta_orchestrator.planner.contracts.errors import ApprovalRequiredError
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
    PlanStatus,
    StageEstimate,
)
from meta_orchestrator.planner.contracts.scope import EstimateAssumptions, StageKind
from meta_orchestrator.planner.estimation.projection import ModelCostProjection
from meta_orchestrator.planner.pricing import (
    CostCalculator,
    PriceCard,
    PriceRate,
    PricingCatalog,
    PricingUnit,
    PriceTrust,
    TokenUsage,
    UsageCategory,
)

USD = "USD"
NOW = "2026-07-29T12:00:00Z"


def m(v: str) -> Money:
    return Money(amount=Decimal(v), currency=USD)


def _trust_card(trust: PriceTrust, *, currency: str = USD) -> PriceCard:
    """A $1/MTok card carrying a chosen trust class, for exercising the guard."""
    cat = UsageCategory
    return PriceCard(
        card_id=f"trust/{trust.value}@v1", pricing_version="test-v1", provider="test",
        model_id=f"trust-{trust.value}", currency=currency,
        unit=PricingUnit.USD_PER_MTOK, effective_from="2026-01-01",
        rates={cat.INPUT: PriceRate.known("1.00"), cat.OUTPUT: PriceRate.known("5.00"),
               cat.CACHE_READ: PriceRate.unknown(), cat.CACHE_WRITE: PriceRate.unknown()},
        trust=trust, source="unit test fixture",
        source_verified_at="2026-01-01").sealed()


_CALC = CostCalculator()

#: Models whose trust class is not the catalog default, built as one-card catalogs so
#: the projections below stay real quotes rather than hand-assembled objects.
_TRUST_CATALOGS = {
    PriceTrust.REPOSITORY_VERIFIED: _CALC,
    PriceTrust.FICTIONAL: CostCalculator(PricingCatalog(cards=[
        _trust_card(PriceTrust.FICTIONAL)])),
    PriceTrust.TEST_ONLY: CostCalculator(PricingCatalog(cards=[
        _trust_card(PriceTrust.TEST_ONLY)])),
    PriceTrust.UNVERIFIED: CostCalculator(PricingCatalog(cards=[
        _trust_card(PriceTrust.UNVERIFIED)])),
}


def _quote(calc: CostCalculator, model_id: str, usd: str):
    """A real quote whose total is ``usd``, derived from the card's actual rate."""
    rate = calc.catalog.card_for(model_id).rate_for(UsageCategory.INPUT).per_token()
    tokens = int(Decimal(usd) / rate)
    return calc.quote(TokenUsage(input_tokens=tokens), model_id=model_id)


def _projection(*, best="10", expected="20", worst="40",
                trust=PriceTrust.REPOSITORY_VERIFIED, available=True,
                model_id=None) -> ModelCostProjection:
    """A projection built from real quotes on a real card.

    Deliberately not hand-assembled: a synthetic projection could carry a combination
    the pricing module would never produce, and then the guard would be tested against
    a shape that cannot occur.
    """
    calc = _TRUST_CATALOGS[trust]
    model_id = model_id or ("claude-haiku-4-5"
                            if trust is PriceTrust.REPOSITORY_VERIFIED
                            else f"trust-{trust.value}")
    if not available:
        return ModelCostProjection(model_id="no-such-model", available=False,
                                   unavailable_reason="no card in the catalog")
    quotes = [_quote(calc, model_id, v) for v in (best, expected, worst)]
    return ModelCostProjection(
        model_id=model_id, available=True,
        range=MoneyRange(best=quotes[0].total, expected=quotes[1].total,
                         worst=quotes[2].total),
        best_quote=quotes[0], expected_quote=quotes[1], worst_quote=quotes[2],
        price_trust=quotes[1].price_trust,
        authoritative_for_real_spend=quotes[1].authoritative_for_real_spend)


def _policy(limit="100", **over) -> BudgetPolicy:
    base = dict(policy_id="pol1", cap=HardBudgetCap(limit=m(limit)))
    base.update(over)
    return BudgetPolicy(**base)


def _state(committed="0", actual="0") -> BudgetState:
    return BudgetState(plan_id="p1", policy_id="pol1",
                       committed=m(committed), actual=m(actual))


def _cost_estimate() -> CostEstimate:
    return CostEstimate(
        range=MoneyRange(best=m("10"), expected=m("20"), worst=m("40")),
        confidence=ConfidenceRange(level=Confidence.UNKNOWN, basis="rules-based"),
        estimator=EstimatorVersion(estimator_id="rules-v1", estimator_version="1.0.0",
                                   pricing_ref="cat/v1", created_at=NOW))


def _plan(**over) -> ExecutionPlan:
    tokens = TokenEstimateRange(best=TokenEstimate(input_tokens=1),
                                expected=TokenEstimate(input_tokens=2),
                                worst=TokenEstimate(input_tokens=3))
    times = TimeEstimateRange(best=TimeEstimate(compute_ms=1),
                              expected=TimeEstimate(compute_ms=2),
                              worst=TimeEstimate(compute_ms=3))
    base = dict(
        plan_id="p1", scope_id="s1", mode=ExecutionMode.AUTOMATIC, plan_version=1,
        stages=[StageEstimate(item_id="gen", kind=StageKind.GENERATE, tokens=tokens,
                              cost=_cost_estimate(), duration=times)],
        total_cost=_cost_estimate(), total_duration=times,
        assumptions=EstimateAssumptions(),
        estimator=EstimatorVersion(estimator_id="rules-v1", estimator_version="1.0.0",
                                   pricing_ref="cat/v1", created_at=NOW),
        model_ids=["claude-haiku-4-5"], plan_hash="hash-v1")
    base.update(over)
    return ExecutionPlan(**base)


# =========================================================================== #
# Reserve — an explicit line item, never a padded rate
# =========================================================================== #

def test_reserve_is_added_to_the_quote_not_folded_into_it():
    """G2 was a wrong rate mistaken for a margin. This keeps the two visible."""
    r = apply_reserve(ReservePolicy(), expected=m("20"), worst=m("40"))
    assert r.quoted == m("40")
    assert r.reserve == m("10")            # 25% of worst
    assert r.total == m("50")


def test_a_zero_reserve_is_a_supported_configuration():
    r = apply_reserve(ReservePolicy.none(), expected=m("20"), worst=m("40"))
    assert r.reserve == Money.zero(USD)
    assert r.total == r.quoted


def test_reserve_can_be_a_fraction_of_expected_or_a_fixed_amount():
    frac = apply_reserve(
        ReservePolicy(basis=ReserveBasis.FRACTION_OF_EXPECTED, fraction="0.5",
                      rationale="half the expected case"),
        expected=m("20"), worst=m("40"))
    assert frac.reserve == m("10")

    fixed = apply_reserve(
        ReservePolicy(basis=ReserveBasis.FIXED_AMOUNT, fixed_amount=m("7"),
                      rationale="flat contingency"),
        expected=m("20"), worst=m("40"))
    assert fixed.reserve == m("7")


def test_a_reserve_policy_must_state_its_rationale():
    with pytest.raises(ValueError, match="where its figure came from"):
        ReservePolicy(rationale="  ")


def test_an_absurd_reserve_fraction_is_rejected():
    with pytest.raises(ValueError, match="more than double"):
        ReservePolicy(fraction="1.5", rationale="x")


def test_a_negative_reserve_is_rejected():
    with pytest.raises(ValueError, match="cannot be negative"):
        ReservePolicy(fraction="-0.1", rationale="x")


def test_the_default_reserve_documents_its_provenance():
    assert "§2" in ReservePolicy().rationale
    assert Decimal(ReservePolicy().fraction) == Decimal("0.25")


# =========================================================================== #
# Admission
# =========================================================================== #

def test_an_affordable_plan_is_admitted():
    """A cap of 200 leaves the 50 admitted well clear of every warning threshold."""
    report = BudgetGuard().admit(_projection(), _policy("200"), _state())
    assert report.allowed
    assert report.result.decision is AdmitDecision.ADMIT
    assert report.requested.total == m("50")       # 40 worst + 25% reserve
    assert report.encumbered_after == m("50")
    assert report.newly_crossed_thresholds == []


def test_landing_exactly_on_a_threshold_counts_as_crossing_it():
    """50 of a 100 cap is at 50%, not below it."""
    report = BudgetGuard().admit(_projection(), _policy("100"), _state())
    assert report.allowed
    assert report.result.decision is AdmitDecision.WARN_AND_ADMIT
    assert Decimal("0.50") in report.newly_crossed_thresholds


def test_admission_is_measured_against_committed_plus_actual():
    """Two calls in flight must not each see room only one of them has."""
    report = BudgetGuard().admit(_projection(), _policy("100"),
                                 _state(committed="30", actual="30"))
    assert report.allowed is False
    assert "past the cap" in report.result.reason


def test_the_reserve_is_what_tips_a_marginal_plan_over():
    guard_with = BudgetGuard()
    guard_without = BudgetGuard(ReservePolicy.none())
    policy, state = _policy("45"), _state()
    assert guard_without.admit(_projection(), policy, state).allowed is True
    assert guard_with.admit(_projection(), policy, state).allowed is False


def test_crossing_a_warning_threshold_admits_with_a_warning():
    report = BudgetGuard(ReservePolicy.none()).admit(
        _projection(worst="60"), _policy("100"), _state())
    assert report.result.decision is AdmitDecision.WARN_AND_ADMIT
    assert Decimal("0.50") in report.newly_crossed_thresholds
    assert any("50%" in w for w in report.warnings)


def test_an_already_crossed_threshold_does_not_fire_again():
    """A warning that repeats is noise, and noise is how a real one gets ignored."""
    report = BudgetGuard(ReservePolicy.none()).admit(
        _projection(best="1", expected="2", worst="5"), _policy("100"),
        _state(actual="60"))
    assert Decimal("0.50") not in report.newly_crossed_thresholds
    assert Decimal("0.75") not in report.newly_crossed_thresholds


def test_a_fictional_price_cannot_back_a_real_budget():
    with pytest.raises(NonAuthoritativePriceError, match="fictional"):
        BudgetGuard().admit(_projection(trust=PriceTrust.FICTIONAL), _policy(), _state())


@pytest.mark.parametrize("trust", [PriceTrust.TEST_ONLY, PriceTrust.UNVERIFIED,
                                   PriceTrust.FICTIONAL])
def test_every_non_authoritative_trust_class_is_refused(trust):
    with pytest.raises(NonAuthoritativePriceError):
        BudgetGuard().admit(_projection(trust=trust), _policy(), _state())


def test_a_non_authoritative_price_may_be_admitted_only_when_asked_explicitly():
    report = BudgetGuard().admit(_projection(trust=PriceTrust.FICTIONAL), _policy(),
                                 _state(), allow_non_authoritative=True)
    assert report.allowed
    assert any("not a real budget" in w for w in report.warnings)


def test_an_unavailable_price_blocks_rather_than_assuming_zero():
    report = BudgetGuard().admit(_projection(available=False), _policy(), _state())
    assert report.allowed is False
    assert "no price available" in report.result.reason


def test_a_currency_mismatch_blocks():
    """No conversion exists at this layer, so a foreign-currency quote cannot admit."""
    ils_calc = CostCalculator(PricingCatalog(cards=[
        _trust_card(PriceTrust.REPOSITORY_VERIFIED, currency="ILS")]))
    model_id = "trust-repository_verified"
    quotes = [_quote(ils_calc, model_id, v) for v in ("1", "2", "3")]
    ils = ModelCostProjection(
        model_id=model_id, available=True,
        range=MoneyRange(best=quotes[0].total, expected=quotes[1].total,
                         worst=quotes[2].total),
        best_quote=quotes[0], expected_quote=quotes[1], worst_quote=quotes[2],
        price_trust=PriceTrust.REPOSITORY_VERIFIED,
        authoritative_for_real_spend=True)
    report = BudgetGuard().admit(ils, _policy(), _state())
    assert report.allowed is False
    assert "no conversion exists" in report.result.reason


def test_breach_action_is_reflected_in_the_reason():
    ask = BudgetGuard().admit(_projection(), _policy("10", on_breach=BreachAction.ASK),
                              _state())
    assert "override decision is required" in ask.result.reason
    degrade = BudgetGuard().admit(
        _projection(), _policy("10", on_breach=BreachAction.DEGRADE), _state())
    assert "cheaper approved plan" in degrade.result.reason


def test_checkpoint_does_not_re_add_the_contingency():
    """Compounding the reserve per call is the same error as burying it in a rate."""
    report = BudgetGuard().checkpoint(_policy("100"), _state(actual="10"), m("5"))
    assert report.requested.reserve == Money.zero(USD)
    assert report.requested.total == m("5")


def test_checkpoint_blocks_before_the_cap_is_crossed():
    report = BudgetGuard().checkpoint(_policy("100"), _state(actual="98"), m("5"))
    assert report.allowed is False


def test_provider_credits_are_reported_separately_and_are_not_a_cap():
    policy = _policy("10", reported_provider_credits=m("500"))
    assert BudgetGuard.credits_cover(policy, m("5")) is True
    assert BudgetGuard.credits_cover(policy, m("900")) is False
    # A healthy balance does not widen the cap.
    assert BudgetGuard().admit(_projection(), policy, _state()).allowed is False


def test_credits_are_none_when_nothing_was_reported():
    assert BudgetGuard.credits_cover(_policy(), m("1")) is None


# =========================================================================== #
# Reservation ledger
# =========================================================================== #

def _ledger() -> ReservationLedger:
    return ReservationLedger.empty(plan_id="p1", policy_id="pol1", currency=USD)


def test_reserving_holds_money_before_it_can_be_spent():
    led = _ledger().reserve(reservation_id="r1", amount=m("30"), cap=m("100"))
    assert led.committed == m("30")
    assert led.actual == Money.zero(USD)
    assert led.state().encumbered == m("30")


def test_reserving_past_the_cap_fails_closed():
    led = _ledger().reserve(reservation_id="r1", amount=m("80"), cap=m("100"))
    with pytest.raises(InsufficientBudgetError, match="past the cap"):
        led.reserve(reservation_id="r2", amount=m("30"), cap=m("100"))


def test_reconciling_replaces_the_hold_with_what_was_billed():
    led = (_ledger()
           .reserve(reservation_id="r1", amount=m("30"), cap=m("100"))
           .reconcile("r1", m("18")))
    assert led.committed == Money.zero(USD)
    assert led.actual == m("18")


def test_releasing_frees_a_hold_that_never_reached_the_provider():
    led = (_ledger()
           .reserve(reservation_id="r1", amount=m("30"), cap=m("100"))
           .release("r1", reason="blocked before send"))
    assert led.committed == Money.zero(USD)
    assert led.actual == Money.zero(USD)


def test_releasing_requires_a_reason():
    led = _ledger().reserve(reservation_id="r1", amount=m("1"), cap=m("100"))
    with pytest.raises(ValueError, match="stated reason"):
        led.release("r1", reason="   ")


def test_an_ambiguous_call_keeps_its_reservation_held():
    """It may have been billed. Freeing the money would let it be spent twice."""
    led = (_ledger()
           .reserve(reservation_id="r1", amount=m("30"), cap=m("100"))
           .mark_ambiguous("r1", reason="connection dropped after send"))
    assert led.committed == m("30")
    assert led.has_unresolved_ambiguity is True
    assert led.reservation("r1").status is ReservationStatus.AMBIGUOUS


def test_an_ambiguous_call_is_resolved_only_by_an_attributed_decision():
    led = (_ledger()
           .reserve(reservation_id="r1", amount=m("30"), cap=m("100"))
           .mark_ambiguous("r1", reason="unknown"))
    with pytest.raises(ValueError, match="must name who decided"):
        led.resolve_ambiguous("r1", was_billed=False, resolved_by="  ")

    billed = led.resolve_ambiguous("r1", was_billed=True, actual=m("25"),
                                   resolved_by="yaniv")
    assert billed.actual == m("25")
    assert billed.has_unresolved_ambiguity is False

    not_billed = led.resolve_ambiguous("r1", was_billed=False, resolved_by="yaniv")
    assert not_billed.actual == Money.zero(USD)
    assert not_billed.committed == Money.zero(USD)


def test_a_reservation_cannot_be_settled_twice():
    led = (_ledger()
           .reserve(reservation_id="r1", amount=m("10"), cap=m("100"))
           .reconcile("r1", m("8")))
    with pytest.raises(DoubleReconcileError):
        led.reconcile("r1", m("8"))


def test_duplicate_reservation_ids_are_refused():
    led = _ledger().reserve(reservation_id="r1", amount=m("1"), cap=m("100"))
    with pytest.raises(ValueError, match="already exists"):
        led.reserve(reservation_id="r1", amount=m("1"), cap=m("100"))


def test_the_ledger_is_immutable():
    before = _ledger()
    after = before.reserve(reservation_id="r1", amount=m("5"), cap=m("100"))
    assert before.committed == Money.zero(USD)
    assert after.committed == m("5")


def test_ledger_state_feeds_the_guard():
    led = (_ledger()
           .reserve(reservation_id="r1", amount=m("40"), cap=m("100"))
           .reconcile("r1", m("40")))
    report = BudgetGuard(ReservePolicy.none()).admit(
        _projection(worst="70"), _policy("100"), led.state())
    assert report.allowed is False


# =========================================================================== #
# Approval gate
# =========================================================================== #

def _presented(gate=None, plan=None, cap="60", **kw):
    gate = gate or ApprovalGate()
    plan = plan or _plan()
    return gate.present(plan, _projection(), request_id="req1",
                        proposed_cap=m(cap), **kw)


def test_a_request_carries_the_priced_figures_not_the_plans_own():
    _, request = _presented()
    assert request.expected_cost == m("20")
    assert request.worst_reasonable_cost == m("40")
    assert request.plan_hash == "hash-v1"


def test_alternatives_are_carried_into_the_request():
    alt = _plan(plan_id="p2", mode=ExecutionMode.LOW_COST,
                tradeoffs=["fewer verification rounds"])
    _, request = _presented(alternatives=[alt])
    assert request.alternative_plan_ids == ["p2"]


def test_presenting_without_a_price_is_refused():
    with pytest.raises(DecisionMismatchError, match="no price is available"):
        ApprovalGate().present(_plan(), _projection(available=False),
                               request_id="req1", proposed_cap=m("60"))


def test_a_non_authoritative_price_is_flagged_on_the_request():
    gate, request = ApprovalGate().present(
        _plan(), _projection(trust=PriceTrust.FICTIONAL), request_id="req1",
        proposed_cap=m("60"))
    assert any("cannot back a real budget" in r for r in request.risks)


def test_recording_a_decision_makes_it_effective():
    gate, request = _presented()
    gate = gate.record(approve(request, decision_id="d1", approved_by="yaniv",
                               decided_at=NOW, approved_cap=m("60"),
                               estimator_ref="rules-v1@1.0.0"))
    effective = gate.effective_decision("p1")
    assert effective is not None and effective.status is ApprovalStatus.APPROVED


def test_a_decision_must_answer_a_request_that_exists():
    gate, request = _presented()
    stray = approve(request, decision_id="d1", approved_by="y", decided_at=NOW,
                    approved_cap=m("60"), estimator_ref="e")
    with pytest.raises(UnknownApprovalRequestError):
        ApprovalGate().record(stray)


def test_a_decision_bound_to_a_different_hash_is_refused():
    gate, request = _presented()
    forged = approve(request, decision_id="d1", approved_by="y", decided_at=NOW,
                     approved_cap=m("60"), estimator_ref="e").model_copy(
                         update={"plan_hash": "hash-v2"})
    with pytest.raises(DecisionMismatchError, match="different plan hash"):
        gate.record(forged)


def test_a_cap_below_the_expected_cost_is_refused_at_recording():
    gate, request = _presented()
    with pytest.raises(DecisionMismatchError, match="guarantees a mid-run halt"):
        gate.record(approve(request, decision_id="d1", approved_by="y",
                            decided_at=NOW, approved_cap=m("5"), estimator_ref="e"))


def test_records_are_append_only():
    gate, request = _presented()
    decision = approve(request, decision_id="d1", approved_by="y", decided_at=NOW,
                       approved_cap=m("60"), estimator_ref="e")
    gate = gate.record(decision)
    with pytest.raises(DecisionAlreadyRecordedError, match="append-only"):
        gate.record(decision)


def test_a_rejection_must_record_why():
    gate, request = _presented()
    gate = gate.record(reject(request, decision_id="d1", approved_by="y",
                              decided_at=NOW, reason="too expensive",
                              estimator_ref="e"))
    assert gate.effective_decision("p1") is None
    assert gate.log.latest_for("p1").reason == "too expensive"


def test_the_gate_is_immutable():
    gate, request = _presented()
    recorded = gate.record(approve(request, decision_id="d1", approved_by="y",
                                   decided_at=NOW, approved_cap=m("60"),
                                   estimator_ref="e"))
    assert gate.effective_decision("p1") is None
    assert recorded.effective_decision("p1") is not None


# =========================================================================== #
# The gate itself — nothing executes without a covering record
# =========================================================================== #

def _approved_gate(cap="60", **plan_kw):
    plan = _plan(**plan_kw)
    gate, request = _presented(plan=plan, cap=cap)
    gate = gate.record(approve(request, decision_id="d1", approved_by="yaniv",
                               decided_at=NOW, approved_cap=m(cap),
                               estimator_ref="rules-v1@1.0.0"))
    return gate, plan


def test_authorising_without_any_decision_fails_closed():
    with pytest.raises(ApprovalRequiredError, match="no approval decision"):
        ApprovalGate().authorise(_plan(), _projection())


def test_authorising_a_covered_run_succeeds():
    gate, plan = _approved_gate()
    assert gate.authorise(plan, _projection()).decision_id == "d1"


def test_an_edited_plan_is_no_longer_covered():
    """The approval binds to a hash, so re-planning withdraws it by construction."""
    gate, plan = _approved_gate()
    edited = plan.model_copy(update={"plan_hash": "hash-v2", "plan_version": 2})
    with pytest.raises(ApprovalRequiredError, match="does not cover"):
        gate.authorise(edited, _projection())


def test_a_projection_grown_past_the_approved_cap_is_not_covered():
    gate, plan = _approved_gate(cap="45")
    with pytest.raises(ApprovalRequiredError, match="does not cover"):
        gate.authorise(plan, _projection(worst="90"))


def test_a_different_execution_mode_is_not_covered():
    gate, plan = _approved_gate()
    other = plan.model_copy(update={"mode": ExecutionMode.LOW_COST,
                                    "tradeoffs": ["fewer rounds"]})
    with pytest.raises(ApprovalRequiredError):
        gate.authorise(other, _projection())


def test_authorising_without_a_price_is_refused():
    gate, plan = _approved_gate()
    with pytest.raises(ApprovalRequiredError, match="without a price"):
        gate.authorise(plan, _projection(available=False))


def test_supersession_withdraws_a_live_approval_without_deleting_it():
    gate, plan = _approved_gate()
    superseded = gate.supersede("p1", reason="plan re-estimated", at=NOW, by="yaniv")
    assert superseded.effective_decision("p1") is None
    # The original record is still readable.
    assert any(d.decision_id == "d1" and d.status is ApprovalStatus.APPROVED
               for d in superseded.log.all_decisions())


def test_an_expired_approval_stops_covering():
    plan = _plan()
    gate, request = _presented(plan=plan)
    gate = gate.record(approve(request, decision_id="d1", approved_by="y",
                               decided_at=NOW, approved_cap=m("60"),
                               estimator_ref="e",
                               valid_until="2026-07-29T13:00:00Z"))
    assert gate.authorise(plan, _projection(), now="2026-07-29T12:30:00Z")
    with pytest.raises(ApprovalRequiredError):
        gate.authorise(plan, _projection(), now="2026-07-29T14:00:00Z")


def test_an_expiring_approval_without_a_clock_is_not_relied_on():
    plan = _plan()
    gate, request = _presented(plan=plan)
    gate = gate.record(approve(request, decision_id="d1", approved_by="y",
                               decided_at=NOW, approved_cap=m("60"),
                               estimator_ref="e", valid_until="2026-08-01T00:00:00Z"))
    assert gate.effective_decision("p1") is None


# =========================================================================== #
# Lifecycle
# =========================================================================== #

def test_awaiting_approval_can_never_transition_straight_to_executing():
    from meta_orchestrator.planner.contracts.errors import IllegalTransitionError

    gate, plan = _approved_gate()
    with pytest.raises(IllegalTransitionError):
        gate.may_transition(plan, PlanStatus.AWAITING_APPROVAL, PlanStatus.EXECUTING,
                            _projection())


def test_approved_to_executing_requires_a_covering_record():
    plan = _plan()
    gate, _ = _presented(plan=plan)                 # presented but never decided
    with pytest.raises(ApprovalRequiredError):
        gate.may_transition(plan, PlanStatus.APPROVED, PlanStatus.EXECUTING,
                            _projection())


def test_approved_to_executing_succeeds_with_a_covering_record():
    gate, plan = _approved_gate()
    gate.may_transition(plan, PlanStatus.APPROVED, PlanStatus.EXECUTING, _projection())


def test_a_transition_needing_no_approval_is_not_gated_by_one():
    gate, plan = _presented(plan=_plan())
    gate.may_transition(plan, PlanStatus.ESTIMATED, PlanStatus.AWAITING_APPROVAL,
                        _projection())


def test_budget_pause_routes_back_through_approval_not_straight_to_executing():
    from meta_orchestrator.planner.contracts.errors import IllegalTransitionError

    gate, plan = _approved_gate()
    with pytest.raises(IllegalTransitionError):
        gate.may_transition(plan, PlanStatus.PAUSED_BUDGET, PlanStatus.EXECUTING,
                            _projection())
    gate.may_transition(plan, PlanStatus.PAUSED_BUDGET, PlanStatus.AWAITING_APPROVAL,
                        _projection())


# =========================================================================== #
# Isolation and boundaries
# =========================================================================== #

def _p1c_modules():
    import pathlib

    root = (pathlib.Path(__file__).resolve().parents[1]
            / "src" / "meta_orchestrator" / "planner")
    return sorted([*(root / "budget").glob("*.py"), *(root / "approval").glob("*.py")])


def test_p1c_does_not_import_the_frozen_experiment_tree():
    import ast

    offenders = []
    for path in _p1c_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                     else [node.module or ""] if isinstance(node, ast.ImportFrom)
                     else [])
            if any("experiment" in n for n in names):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []


def test_p1c_performs_no_network_or_persistence():
    import ast

    banned = {"socket", "http", "httpx", "requests", "urllib", "anthropic",
              "subprocess", "sqlite3", "ssl", "asyncio", "os", "pathlib", "io"}
    offenders = []
    for path in _p1c_modules():
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


def test_neither_component_is_wired_to_the_orchestrator():
    import inspect

    from meta_orchestrator.orchestrator import orchestrator as orch_mod

    source = inspect.getsource(orch_mod)
    for name in ("planner.budget", "planner.approval", "BudgetGuard", "ApprovalGate"):
        assert name not in source


def test_neither_component_can_execute_or_spend():
    forbidden = {"execute", "run", "send", "spend", "charge", "call_model"}
    for cls in (BudgetGuard, ApprovalGate):
        assert not (forbidden & {n for n in dir(cls) if not n.startswith("_")})


# =========================================================================== #
# A worked end-to-end pass, kept as documentation
# =========================================================================== #

def test_worked_example_price_admit_approve_reserve_reconcile():
    """The whole P1c path, with nothing executed.

    A plan projected at 20 expected / 40 worst, a cap of 100, a 25% contingency.
    """
    projection = _projection(best="10", expected="20", worst="40")
    policy = _policy("100")
    guard = BudgetGuard()

    admission = guard.admit(projection, policy, _state())
    assert admission.allowed
    assert admission.requested.quoted == m("40")
    assert admission.requested.reserve == m("10")
    assert admission.requested.total == m("50")

    plan = _plan()
    gate, request = ApprovalGate().present(plan, projection, request_id="req1",
                                           proposed_cap=m("50"))
    gate = gate.record(approve(request, decision_id="d1", approved_by="yaniv",
                               decided_at=NOW, approved_cap=m("50"),
                               estimator_ref="rules-v1@1.0.0"))
    decision = gate.authorise(plan, projection)
    assert decision.approved_cap == m("50")

    ledger = (ReservationLedger.empty(plan_id="p1", policy_id="pol1", currency=USD)
              .reserve(reservation_id="call-1", amount=m("50"), cap=policy.cap.limit))
    assert ledger.committed == m("50")

    ledger = ledger.reconcile("call-1", m("22"))
    assert ledger.actual == m("22")
    assert ledger.committed == Money.zero(USD)
    assert ledger.state().remaining(policy.cap) == m("78")
