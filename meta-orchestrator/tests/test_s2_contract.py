"""Haiku CONTRACT test (acceptance criterion 6) — proves the adapter is faithful to Decision A.

Offline and $0: it inspects the request payload the adapter WOULD send; nothing is sent. This
is the guard that catches the two catalog-verified footguns — sending ``effort`` (errors on
Haiku 4.5) or the wrong ``budget_tokens`` (the generic helper would send 2048, not the frozen
1024 floor).
"""
from __future__ import annotations

from meta_orchestrator.experiment.s2.contract_s2 import (S2_EXACT_MODEL_ID, S2_MAX_TOKENS,
                                                        S2_THINKING_BUDGET_TOKENS,
                                                        _deep_key_present,
                                                        anthropic_request_kwargs,
                                                        frozen_s2_contract, s2_run_policy)


def test_adapter_sends_enabled_thinking_with_budget_1024():
    kw = anthropic_request_kwargs(frozen_s2_contract(), prompt="fix the bug")
    assert kw["thinking"] == {"type": "enabled", "budget_tokens": 1024}
    assert kw["thinking"]["type"] == "enabled"
    assert kw["thinking"]["budget_tokens"] == S2_THINKING_BUDGET_TOKENS == 1024
    # the floor, and strictly below max_tokens (Haiku-4.5 requirement)
    assert kw["thinking"]["budget_tokens"] < kw["max_tokens"]


def test_adapter_never_sends_effort():
    kw = anthropic_request_kwargs(frozen_s2_contract(), prompt="x")
    # output_config.effort ERRORS on Haiku 4.5 — it must appear nowhere in the payload.
    assert "output_config" not in kw
    assert not _deep_key_present(kw, "effort")
    assert not _deep_key_present(kw, "output_config")
    # the frozen contract itself carries no effort key either
    assert not _deep_key_present(frozen_s2_contract().reasoning_settings, "effort")


def test_adapter_never_sends_temperature_or_sampling():
    kw = anthropic_request_kwargs(frozen_s2_contract(), prompt="x")
    for banned in ("temperature", "top_p", "top_k"):
        assert banned not in kw
        assert not _deep_key_present(kw, banned)


def test_adapter_pins_exact_snapshot_and_max_tokens():
    kw = anthropic_request_kwargs(frozen_s2_contract(), prompt="x")
    assert kw["model"] == S2_EXACT_MODEL_ID == "claude-haiku-4-5-20251001"
    assert kw["max_tokens"] == S2_MAX_TOKENS == 4096


def test_run_policy_disables_fallback():
    policy = s2_run_policy()
    assert policy.experiment_mode is True
    assert policy.fallback == "off"            # no silent fallback (undetectable confound)
    assert policy.sends_effort is False
    assert policy.sends_temperature is False


def test_contract_snapshot_is_stable():
    assert frozen_s2_contract().snapshot() == frozen_s2_contract().snapshot()


def test_generic_helper_would_violate_the_frozen_budget():
    """Documents WHY §2 owns its builder: the generic helper sends 2048, not the frozen 1024."""
    from meta_orchestrator.gateway.adapters import thinking_kwargs
    generic = thinking_kwargs("claude-haiku-4-5-20251001", 4096, "high")
    assert generic["thinking"]["budget_tokens"] == 2048          # != the frozen 1024 floor
    assert anthropic_request_kwargs(
        frozen_s2_contract(), prompt="x")["thinking"]["budget_tokens"] == 1024
