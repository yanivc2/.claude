"""P2a: the Planner wired into the orchestrator in shadow mode.

The whole contract of this phase is *observe, change nothing*. These tests hold the
Planner to it: with the flags off the orchestrator is byte-for-byte what it was; with
them on it produces a shadow observation off to the side while the run — its decision,
its routing, its tokens, its output — is identical. Enforcement and real spend are
refused. A Planner that throws does not touch the run.

Offline and deterministic: no network, no provider call, no clock except an injected
one. The only I/O is the in-memory sink.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.config import OrchestratorConfig
from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.planner.estimation.metrics import (
    ContentFamily,
    ContentMetrics,
    ScriptHint,
)
from meta_orchestrator.planner.integration import (
    InMemoryShadowSink,
    PlannerShadowResult,
    ShadowConfigError,
    ShadowFailureKind,
    ShadowRunner,
    build_request,
    build_stages,
    code_metrics,
)
from meta_orchestrator.planner.integration.request_adapter import build_plan_snapshot
from meta_orchestrator.seed_task.corpus import get_case
from meta_orchestrator.seed_task.definition import BugCase

FIXED_NOW = "2026-07-29T00:00:00Z"

UNSOLVABLE = BugCase(
    bug_id="unsolvable_demo",
    category="unknown_cat",
    module_filename="solution.py",
    module_source="def f():\n    return 0\n",
    test_source="from solution import f\n\ndef test_f():\n    assert f() == 1\n",
    reference_fix="def f():\n    return 1\n",
)


def _orch(**flags) -> Orchestrator:
    cfg = OrchestratorConfig(**flags)
    store, registry, config = boot(cfg)
    return Orchestrator(store, registry, config)


def _run_result(runner: ShadowRunner, case, *, legacy_tokens=155, legacy_cost=0.0025,
                candidates=None) -> PlannerShadowResult:
    res = runner.run_shadow(
        case, candidate_model_ids=candidates or ["mock-strong", "mock-weak"],
        legacy_tokens=legacy_tokens, legacy_cost=legacy_cost, max_rounds=6,
        correlation_id="corr")
    assert res is not None
    return res


# --------------------------------------------------------------------------- #
# Flags: default off, and off means nothing is built                          #
# --------------------------------------------------------------------------- #
def test_flags_default_to_off():
    cfg = OrchestratorConfig()
    assert cfg.planner_enabled is False
    assert cfg.planner_shadow_mode is False
    assert cfg.planner_enforcement_enabled is False
    assert cfg.planner_real_spend_enabled is False


def test_planner_disabled_builds_no_runner_and_no_sink():
    orch = _orch(planner_enabled=False)
    assert orch.shadow_runner is None
    assert orch.shadow_sink is None


def test_shadow_enabled_builds_an_in_memory_sink():
    orch = _orch(planner_enabled=True, planner_shadow_mode=True)
    assert orch.shadow_runner is not None
    assert isinstance(orch.shadow_sink, InMemoryShadowSink)  # in memory: opens no database


# --------------------------------------------------------------------------- #
# The central invariant: the run is identical whether the shadow ran or not   #
# --------------------------------------------------------------------------- #
def _outcome_fingerprint(out):
    # A stable projection of the outcome. The postmortem's ``root_cause`` embeds the
    # pytest run's own wall-clock duration (e.g. "1 failed in 0.03s"), which varies
    # between two runs regardless of the shadow — so we compare the stable postmortem
    # fields, not that free text. Everything the shadow could possibly influence
    # (decision, routing, tokens, cost, trace shape) is here.
    pm = out.postmortem
    stable_pm = (pm.get("actual_passed"), pm.get("failure_category"),
                 pm.get("update_action"), pm.get("playbook_updated"),
                 pm.get("predicted_p_success"), pm.get("calibration_gap"))
    return (out.passed, out.status, out.selected_model, out.rounds, out.cost,
            out.tokens_spent, out.playbook_key, len(out.trace), stable_pm)


def test_a_successful_run_is_byte_for_byte_identical_with_shadow_on():
    off = _orch(planner_enabled=False).run(get_case("off_by_one_sum"), run_id="r")
    on = _orch(planner_enabled=True, planner_shadow_mode=True).run(
        get_case("off_by_one_sum"), run_id="r")
    assert _outcome_fingerprint(off) == _outcome_fingerprint(on)


def test_an_aborted_run_is_identical_with_shadow_on():
    # A one-token budget forces the circuit breaker to abort before any paid work.
    off = _orch(planner_enabled=False, budget_tokens=1).run(
        get_case("off_by_one_sum"), run_id="r")
    on = _orch(planner_enabled=True, planner_shadow_mode=True, budget_tokens=1).run(
        get_case("off_by_one_sum"), run_id="r")
    assert off.status == on.status == "aborted_budget"
    assert _outcome_fingerprint(off) == _outcome_fingerprint(on)


def test_a_blocked_run_is_identical_with_shadow_on():
    off = _orch(planner_enabled=False).run(UNSOLVABLE, run_id="r")
    on = _orch(planner_enabled=True, planner_shadow_mode=True).run(UNSOLVABLE, run_id="r")
    assert off.status == on.status == "blocked"
    assert _outcome_fingerprint(off) == _outcome_fingerprint(on)


def test_shadow_run_adds_no_tokens_and_no_cost():
    off = _orch(planner_enabled=False).run(get_case("off_by_one_sum"), run_id="r")
    on = _orch(planner_enabled=True, planner_shadow_mode=True).run(
        get_case("off_by_one_sum"), run_id="r")
    assert on.tokens_spent == off.tokens_spent      # the shadow spends nothing
    assert on.cost == off.cost


# --------------------------------------------------------------------------- #
# Shadow enabled but not acting: it records, it does not decide               #
# --------------------------------------------------------------------------- #
def test_enabled_shadow_records_exactly_one_result_per_run():
    orch = _orch(planner_enabled=True, planner_shadow_mode=True)
    orch.run(get_case("off_by_one_sum"), run_id="r")
    assert len(orch.shadow_sink.results) == 1
    assert len(orch.shadow_sink.failures) == 0


def test_enabled_without_shadow_mode_records_nothing():
    # planner_enabled alone (shadow_mode off) is not an authorised P2a state; the gate
    # must not run the observer.
    orch = _orch(planner_enabled=True, planner_shadow_mode=False)
    orch.run(get_case("off_by_one_sum"), run_id="r")
    assert orch.shadow_sink is not None
    assert orch.shadow_sink.results == []


def test_recorded_result_is_a_simulation_that_cannot_back_real_spend():
    orch = _orch(planner_enabled=True, planner_shadow_mode=True)
    orch.run(get_case("off_by_one_sum"), run_id="r")
    res = orch.shadow_sink.last_result
    assert res.purpose == "simulation"
    assert res.eligibility_marker == "NOT_ELIGIBLE_FOR_REAL_SPEND"
    assert res.selected_model is None            # no model is selected pre-flight
    assert res.confidence == "unknown"           # never calibrated


# --------------------------------------------------------------------------- #
# Enforcement and real spend are refused, not silently ignored                #
# --------------------------------------------------------------------------- #
def test_enforcement_is_refused_at_construction():
    with pytest.raises(ShadowConfigError):
        _orch(planner_enabled=True, planner_shadow_mode=True,
              planner_enforcement_enabled=True)


def test_real_spend_is_refused_at_construction():
    with pytest.raises(ShadowConfigError):
        _orch(planner_enabled=True, planner_shadow_mode=True,
              planner_real_spend_enabled=True)


def test_the_runner_itself_refuses_enforcement_and_real_spend():
    with pytest.raises(ShadowConfigError):
        ShadowRunner(now=lambda: FIXED_NOW, enforcement=True)
    with pytest.raises(ShadowConfigError):
        ShadowRunner(now=lambda: FIXED_NOW, real_spend=True)


# --------------------------------------------------------------------------- #
# Divergence: legacy chars//4 vs the product estimator                        #
# --------------------------------------------------------------------------- #
def test_divergence_compares_legacy_against_the_planner_band():
    runner = ShadowRunner(now=lambda: FIXED_NOW)
    res = _run_result(runner, get_case("off_by_one_sum"), legacy_tokens=155)
    d = res.divergence
    assert d.legacy_tokens == 155
    assert d.planner_tokens_best <= d.planner_tokens_expected <= d.planner_tokens_worst
    assert d.token_divergence_abs == d.planner_tokens_expected - 155
    # the whole reason for the phase: the runtime heuristic is far below the estimate
    assert d.legacy_tokens_in_planner_range is False


def test_token_divergence_percentage_is_none_when_legacy_is_zero():
    runner = ShadowRunner(now=lambda: FIXED_NOW)
    res = _run_result(runner, get_case("off_by_one_sum"), legacy_tokens=0)
    assert res.divergence.token_divergence_pct is None      # no denominator, no fraction


def test_legacy_value_inside_the_band_is_reported_as_such():
    runner = ShadowRunner(now=lambda: FIXED_NOW)
    res = _run_result(runner, get_case("off_by_one_sum"))
    d = res.divergence
    inside = (d.planner_tokens_best + d.planner_tokens_worst) // 2
    res2 = _run_result(runner, get_case("off_by_one_sum"), legacy_tokens=inside)
    assert res2.divergence.legacy_tokens_in_planner_range is True


# --------------------------------------------------------------------------- #
# Price trust (§12): stated, never overstated                                 #
# --------------------------------------------------------------------------- #
def test_mock_prices_are_fictional_and_not_authoritative():
    runner = ShadowRunner(now=lambda: FIXED_NOW)
    res = _run_result(runner, get_case("off_by_one_sum"),
                      candidates=["mock-strong", "mock-weak"])
    assert res.authoritative_for_real_spend is False
    assert any("not authoritative" in w for w in res.warnings)


def test_repository_verified_prices_are_billable_but_not_provider_verified():
    runner = ShadowRunner(now=lambda: FIXED_NOW)
    res = _run_result(runner, get_case("off_by_one_sum"),
                      candidates=["claude-opus-4-8", "claude-haiku-4-5"])
    assert res.authoritative_for_real_spend is True
    # governance still records that the price was never re-checked against the provider
    assert "price_not_provider_verified" in res.acknowledgeable_condition_codes


def test_a_model_with_no_price_card_degrades_to_a_tokens_only_result():
    runner = ShadowRunner(now=lambda: FIXED_NOW)
    res = _run_result(runner, get_case("off_by_one_sum"),
                      candidates=["does-not-exist"])
    # token comparison still stands; cost side is unavailable, and it says so
    assert res.divergence.planner_tokens_worst > 0
    assert res.divergence.planner_cost_worst is None
    assert any("no candidate had a usable price" in w for w in res.warnings)


# --------------------------------------------------------------------------- #
# Governance preview under SIMULATION                                         #
# --------------------------------------------------------------------------- #
def test_governance_preview_runs_as_simulation():
    runner = ShadowRunner(now=lambda: FIXED_NOW)
    res = _run_result(runner, get_case("off_by_one_sum"),
                      candidates=["claude-opus-4-8"])
    assert res.governance_preview_available is True
    assert res.would_admit_as_simulation is True         # nothing blocking under simulation
    assert res.blocking_condition_codes == []


# --------------------------------------------------------------------------- #
# Content families route to the right rule (§16)                              #
# --------------------------------------------------------------------------- #
def test_code_metrics_classify_as_source_code():
    m = code_metrics("def f():\n    return 1\n")
    assert m.family is ContentFamily.SOURCE_CODE
    assert m.script is ScriptHint.LATIN
    assert m.code_points > 0


def test_hebrew_content_is_denser_than_latin_for_the_same_size():
    # Same code_points, different family -> the Hebrew rule must yield more tokens.
    from meta_orchestrator.planner.estimation.estimator import UsageEstimator
    from meta_orchestrator.planner.estimation.request import (
        EstimationRequest,
        StageInput,
    )
    from meta_orchestrator.planner.contracts.plan import ExecutionMode
    from meta_orchestrator.planner.contracts.scope import StageKind

    est = UsageEstimator()

    def tokens_for(family: ContentFamily, script: ScriptHint) -> int:
        stage = StageInput(
            stage_id="s", kind=StageKind.GENERATE,
            inputs=[ContentMetrics(family=family, code_points=1000, utf8_bytes=2000,
                                   script=script)],
            primary_calls=1, max_retries=0, output_profile_id="default_short")
        req = EstimationRequest(
            request_id="r", scope_id="sc", plan_id="p", plan_version=1,
            plan_hash="h" * 64, mode=ExecutionMode.AUTOMATIC, stages=[stage],
            candidate_model_ids=[])
        return est.estimate(req).input_tokens.expected

    hebrew = tokens_for(ContentFamily.PROSE_HEBREW, ScriptHint.HEBREW)
    latin = tokens_for(ContentFamily.PROSE_LATIN, ScriptHint.LATIN)
    assert hebrew > latin


# --------------------------------------------------------------------------- #
# The adapter models the real runtime shape (§9)                              #
# --------------------------------------------------------------------------- #
def test_retry_allowance_matches_the_circuit_breaker_rounds():
    stages = build_stages(get_case("off_by_one_sum"), max_rounds=6)
    generate = next(s for s in stages if s.stage_id == "generate")
    assert generate.max_retries == 5                    # max_rounds - 1
    assert generate.max_retries is not None             # bounded: an unbounded worst case is refused


def test_candidate_models_pass_through_to_the_plan_snapshot():
    stages = build_stages(get_case("off_by_one_sum"), max_rounds=6)
    plan = build_plan_snapshot(get_case("off_by_one_sum"),
                               candidate_model_ids=["mock-strong", "mock-weak"],
                               stages=stages)
    assert plan.model_ids == ["mock-strong", "mock-weak"]


def test_request_and_plan_reference_one_identical_plan_hash():
    req, plan = build_request(get_case("off_by_one_sum"),
                              candidate_model_ids=["mock-strong"], max_rounds=6)
    assert req.plan_hash == plan.content_hash()


# --------------------------------------------------------------------------- #
# Error isolation (§14): a Planner that throws never touches the run          #
# --------------------------------------------------------------------------- #
def test_a_broken_estimator_records_a_failure_and_returns_none(monkeypatch):
    runner = ShadowRunner(now=lambda: FIXED_NOW)

    def boom(_request):
        raise RuntimeError("estimator exploded")

    monkeypatch.setattr(runner._estimator, "estimate", boom)
    out = runner.run_shadow(get_case("off_by_one_sum"),
                            candidate_model_ids=["mock-strong"], legacy_tokens=100,
                            legacy_cost=0.01, max_rounds=6, correlation_id="c")
    assert out is None                                   # never raises to the caller
    assert len(runner.sink.failures) == 1
    assert runner.sink.failures[0].kind == ShadowFailureKind.UNEXPECTED_INTERNAL_ERROR.value


def test_a_broken_shadow_does_not_break_the_orchestrator(monkeypatch):
    orch = _orch(planner_enabled=True, planner_shadow_mode=True)

    def boom(*a, **k):
        raise RuntimeError("shadow exploded")

    monkeypatch.setattr(orch.shadow_runner, "run_shadow", boom)
    out = orch.run(get_case("off_by_one_sum"), run_id="r")
    assert out.status == "completed"                     # the run is unharmed
    assert out.passed is True


# --------------------------------------------------------------------------- #
# Determinism and identity (§16)                                              #
# --------------------------------------------------------------------------- #
def test_the_result_hash_is_deterministic_and_ignores_latency():
    r1 = ShadowRunner(now=lambda: FIXED_NOW, timer=lambda: 0.0)
    r2 = ShadowRunner(now=lambda: FIXED_NOW, timer=lambda: 999.0)   # different clock
    a = _run_result(r1, get_case("off_by_one_sum"))
    b = _run_result(r2, get_case("off_by_one_sum"))
    assert a.content_hash() == b.content_hash()
    assert len(a.content_hash()) == 64


def test_the_flags_fingerprint_is_recorded_on_the_result():
    res = _run_result(ShadowRunner(now=lambda: FIXED_NOW), get_case("off_by_one_sum"))
    assert len(res.flags_fingerprint) == 64             # the shadow config is part of identity


def test_latency_is_measured():
    res = _run_result(ShadowRunner(now=lambda: FIXED_NOW), get_case("off_by_one_sum"))
    assert res.latency.total_ms >= 0.0
    assert res.latency.estimation_ms >= 0.0


# --------------------------------------------------------------------------- #
# No spend, no reservation, no database (§10, §11, §21)                        #
# --------------------------------------------------------------------------- #
def test_shadow_creates_no_reservation_and_opens_no_database():
    orch = _orch(planner_enabled=True, planner_shadow_mode=True)
    orch.run(get_case("off_by_one_sum"), run_id="r")
    # the sink holds observations only — there is no reservation, settlement, or store
    assert isinstance(orch.shadow_sink, InMemoryShadowSink)
    assert not hasattr(orch.shadow_sink, "connection")
    assert all(isinstance(r, PlannerShadowResult) for r in orch.shadow_sink.results)
