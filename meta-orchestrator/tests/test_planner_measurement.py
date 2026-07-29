"""P2m: the Measured Token Pilot — measure only, calibrate nothing.

Offline and deterministic. The measured column is exercised with a stub client that
stands in for the provider's token-count endpoint, so the *pipeline* is fully tested
without a network call or a key. A stub is never a real token count, and the real
network path is fail-closed and covered by an opt-in test that skips without a key.

Nothing here changes an estimator coefficient, enforces anything, or touches
experiment/s2.
"""
from __future__ import annotations

import os

import pytest

from meta_orchestrator.planner.estimation.metrics import ContentFamily, ScriptHint
from meta_orchestrator.planner.estimation.profiles import TOKEN_RULES
from meta_orchestrator.planner.measurement import (
    CORPUS,
    AnthropicCountTokensCounter,
    CredentialUnavailableError,
    PilotBudget,
    PilotBudgetExhaustedError,
    UnsupportedModelError,
    ZeroTokenMeasurementError,
    corpus_manifest,
    legacy_estimate,
    run_pilot,
)
from meta_orchestrator.planner.measurement.counter import PILOT_MODEL_SNAPSHOT
from meta_orchestrator.planner.measurement.entities import CountingMethod

NOW = lambda: "2026-07-29T00:00:00Z"  # noqa: E731 — injected clock, deterministic


# --------------------------------------------------------------------------- #
# Stub client: a tokenizer stand-in that records exactly which methods it saw  #
# --------------------------------------------------------------------------- #
class _Resp:
    def __init__(self, n, request_id="req_stub"):
        self.input_tokens = n
        self._request_id = request_id


class _Messages:
    def __init__(self, rule, calls, request_id="req_stub"):
        self._rule = rule
        self._calls = calls
        self._request_id = request_id

    def count_tokens(self, **kwargs):
        self._calls.append("count_tokens")
        text = kwargs["messages"][0]["content"]
        return _Resp(self._rule(text), self._request_id)

    def create(self, **kwargs):        # generation — must never be called
        self._calls.append("create")
        raise AssertionError("generation must never happen in P2m")


class StubClient:
    def __init__(self, rule=lambda t: max(1, len(t) // 3), request_id="req_stub"):
        self.calls: list[str] = []
        self.messages = _Messages(rule, self.calls, request_id)
        self.api_key = "stub"          # injected clients skip the real credential check


def _stub_counter(rule=lambda t: max(1, len(t) // 3), budget=None):
    return AnthropicCountTokensCounter(budget=budget or PilotBudget(), client=StubClient(rule))


# --------------------------------------------------------------------------- #
# Corpus                                                                      #
# --------------------------------------------------------------------------- #
def test_corpus_has_seven_families_at_three_sizes():
    assert len(CORPUS) == 21
    seen: dict[str, set[str]] = {}
    for s in CORPUS:
        seen.setdefault(s.family.value, set()).add(s.size)
    assert len(seen) == 7
    for fam, sizes in seen.items():
        assert sizes == {"short", "medium", "long"}, fam


def test_corpus_manifest_is_deterministic():
    assert corpus_manifest()["manifest_hash"] == corpus_manifest()["manifest_hash"]


def test_sample_ids_are_unique():
    ids = [s.sample_id for s in CORPUS]
    assert len(set(ids)) == len(ids)


def test_sample_content_hashes_are_full_sha256():
    for s in CORPUS:
        assert len(s.content_hash) == 64


def test_no_sample_is_empty():
    for s in CORPUS:
        assert s.text.strip()


def test_no_sample_carries_a_secret():
    banned = ("sk-ant", "api_key", "authorization: bearer", "-----begin", "password=")
    for s in CORPUS:
        low = s.text.lower()
        assert not any(b in low for b in banned), s.sample_id


def test_content_family_and_script_mapping():
    heb = [s for s in CORPUS if s.family is ContentFamily.PROSE_HEBREW]
    assert heb and all(s.script is ScriptHint.HEBREW for s in heb)
    mixed = [s for s in CORPUS if s.family is ContentFamily.PROSE_MIXED]
    assert mixed and all(s.script is ScriptHint.MIXED for s in mixed)
    code = [s for s in CORPUS if s.family is ContentFamily.SOURCE_CODE]
    assert code and all(s.script is ScriptHint.LATIN for s in code)


def test_metrics_bytes_never_below_code_points():
    for s in CORPUS:
        m = s.metrics()
        assert m.utf8_bytes >= m.code_points
        assert m.code_points > 0


# --------------------------------------------------------------------------- #
# Legacy and Planner columns (offline, always present)                        #
# --------------------------------------------------------------------------- #
def test_legacy_estimate_is_chars_over_four():
    assert legacy_estimate(400) == 100
    assert legacy_estimate(0) == 0


def test_offline_run_produces_legacy_and_planner_but_no_measurement():
    run = run_pilot(now=NOW, counter=None, blocked_reason="no credential")
    assert run.measured is False
    assert run.blocked_reason == "no credential"
    assert run.counting_method is CountingMethod.NOT_MEASURED
    assert len(run.measurements) == 21
    for m in run.measurements:
        assert m.measured_tokens is None
        assert m.planner_best <= m.planner_expected <= m.planner_worst
        assert m.legacy_tokens == m.code_points // 4


def test_offline_run_reports_family_analyses_without_measured_fields():
    run = run_pilot(now=NOW, counter=None)
    assert len(run.family_analyses) == 7
    for fa in run.family_analyses:
        assert fa.measured_available is False
        assert fa.median_measured_tokens is None
        assert 0 <= fa.legacy_in_planner_range_rate <= 1


# --------------------------------------------------------------------------- #
# Measured pipeline (stub client — pipeline only, not a real count)           #
# --------------------------------------------------------------------------- #
def test_stub_run_fills_the_measured_column_and_errors():
    run = run_pilot(now=NOW, counter=_stub_counter())
    assert run.measured is True
    assert run.counting_method is CountingMethod.PROVIDER_COUNT_TOKENS_API
    for m in run.measurements:
        assert m.measured_tokens is not None
        assert m.legacy_abs_error is not None
        assert m.legacy_pct_error is not None
        assert m.planner_expected_abs_error is not None
        assert m.measured_in_planner_range in (True, False)
        assert m.code_points_per_measured_token is not None


def test_measurement_hash_is_deterministic():
    a = run_pilot(now=NOW, counter=_stub_counter()).measurements[0]
    b = run_pilot(now=NOW, counter=_stub_counter()).measurements[0]
    assert a.content_hash() == b.content_hash()
    assert len(a.content_hash()) == 64


def test_only_count_tokens_is_ever_called_never_generation():
    client = StubClient()
    counter = AnthropicCountTokensCounter(budget=PilotBudget(), client=client)
    run_pilot(now=NOW, counter=counter)
    assert client.calls, "the counter should have called the endpoint"
    assert set(client.calls) == {"count_tokens"}         # never 'create'


def test_percentage_error_needs_a_positive_measured_value():
    # A stub returning zero for non-empty input must be refused, not divided by.
    with pytest.raises(ZeroTokenMeasurementError):
        _stub_counter(rule=lambda t: 0).count("non-empty")


def test_family_analysis_aggregates_when_measured():
    run = run_pilot(now=NOW, counter=_stub_counter())
    for fa in run.family_analyses:
        assert fa.measured_available is True
        assert fa.median_measured_tokens is not None
        assert fa.planner_range_coverage is not None
        assert fa.under_estimation_rate is not None
        assert fa.over_estimation_rate is not None


def test_missing_request_id_is_tolerated():
    counter = AnthropicCountTokensCounter(
        budget=PilotBudget(), client=StubClient(request_id=None))
    run = run_pilot(now=NOW, counter=counter)
    assert run.measured is True                          # missing request id does not break it
    assert all(m.request_id is None for m in run.measurements)


def test_provider_and_model_are_always_recorded():
    run = run_pilot(now=NOW, counter=None)
    for m in run.measurements:
        assert m.provider == "anthropic"
        assert m.model_id == "claude-haiku-4-5"


# --------------------------------------------------------------------------- #
# Budget, credentials, model — fail-closed everywhere                         #
# --------------------------------------------------------------------------- #
def test_budget_cap_stops_measurement_mid_run_without_raising():
    # Only two calls allowed; the run must degrade to offline, not blow up.
    budget = PilotBudget(max_calls=2)
    run = run_pilot(now=NOW, counter=_stub_counter(budget=budget))
    assert budget.calls_made == 2
    assert run.blocked_reason and "budget exhausted" in run.blocked_reason
    measured = [m for m in run.measurements if m.measured_available]
    assert len(measured) == 2                            # exactly the two authorised


def test_budget_authorise_is_fail_closed():
    budget = PilotBudget(max_calls=0)
    with pytest.raises(PilotBudgetExhaustedError):
        budget.authorise_call()


def test_real_counter_without_credential_is_blocked():
    # No key in the test environment -> fail-closed at construction, never a guess.
    if os.getenv("ANTHROPIC_API_KEY"):
        pytest.skip("a real credential is present; the block cannot be exercised")
    with pytest.raises(CredentialUnavailableError):
        AnthropicCountTokensCounter(budget=PilotBudget())


def test_a_model_other_than_haiku_is_refused():
    with pytest.raises(UnsupportedModelError):
        AnthropicCountTokensCounter(budget=PilotBudget(), model_id="claude-opus-4-8",
                                    client=StubClient())


def test_the_pilot_model_is_pinned_to_a_dated_snapshot():
    counter = AnthropicCountTokensCounter(budget=PilotBudget(), client=StubClient())
    assert counter._model == PILOT_MODEL_SNAPSHOT
    assert PILOT_MODEL_SNAPSHOT == "claude-haiku-4-5-20251001"


# --------------------------------------------------------------------------- #
# No mutation, no enforcement, no §2 contact                                  #
# --------------------------------------------------------------------------- #
def test_the_pilot_does_not_mutate_estimator_coefficients():
    before = {k: v.expected_cp_per_token for k, v in TOKEN_RULES.items()}
    run_pilot(now=NOW, counter=_stub_counter())
    after = {k: v.expected_cp_per_token for k, v in TOKEN_RULES.items()}
    assert before == after


def test_the_measurement_package_does_not_import_experiment_or_orchestrator():
    # Scan import statements only — docstrings mention both by name to disclaim them.
    import inspect

    from meta_orchestrator.planner.measurement import corpus, counter, entities, pilot
    for mod in (corpus, counter, entities, pilot):
        for line in inspect.getsource(mod).splitlines():
            stripped = line.strip()
            if stripped.startswith(("import ", "from ")):
                assert "experiment" not in stripped, (mod.__name__, line)
                assert "orchestrator.orchestrator" not in stripped, (mod.__name__, line)


# --------------------------------------------------------------------------- #
# Opt-in real network measurement (skipped without a key)                     #
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(
    not (os.getenv("ANTHROPIC_API_KEY") and os.getenv("META_ORCH_RUN_TOKEN_PILOT")),
    reason="real token-count pilot is opt-in: set ANTHROPIC_API_KEY and META_ORCH_RUN_TOKEN_PILOT")
def test_real_token_count_pilot_opt_in():  # pragma: no cover - network, opt-in
    budget = PilotBudget()
    counter = AnthropicCountTokensCounter(budget=budget)
    run = run_pilot(now=NOW, counter=counter)
    assert run.measured is True
    assert budget.calls_made <= budget.max_calls
    for m in run.measurements:
        assert m.measured_tokens and m.measured_tokens > 0
