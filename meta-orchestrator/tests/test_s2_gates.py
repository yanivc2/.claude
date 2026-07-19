"""Final offline safeguards (3rd review P0s): canonical request, counter isolation, gates.

Pure and offline. Proves one canonical request feeds both adapters; proxy/real counts cannot
cross namespaces or masquerade; Gate-2 training completeness; and the per-call runtime invariant.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.s2 import (AnthropicTokenCounter, CallContext,
                                             CounterProvenanceError, GateError, PROXY_SOURCE,
                                             REAL_SOURCE, ProxyTokenCounter, assert_call_allowed,
                                             assert_context_cap_production_valid,
                                             assert_training_complete, build_canonical,
                                             context_cap_preflight, differential_fields_match,
                                             is_production_count)
from meta_orchestrator.experiment.s2 import build_synthetic_corpus
from meta_orchestrator.experiment.s2.gates import assert_b1_selection_production_valid
from meta_orchestrator.experiment.s2.b1_selector import B1Selection


# --- P0.1 canonical request --------------------------------------------------------------
def test_one_canonical_feeds_both_adapters():
    req = build_canonical(prompt="fix the bug")
    assert differential_fields_match(req)                    # shared fields identical
    assert "max_tokens" in req.messages_kwargs()
    assert "max_tokens" not in req.count_tokens_kwargs()     # endpoint-specific only
    # both adapters agree on the semantic core
    assert req.messages_kwargs()["model"] == req.count_tokens_kwargs()["model"]
    assert req.messages_kwargs()["messages"] == req.count_tokens_kwargs()["messages"]
    assert req.messages_kwargs().get("thinking") == req.count_tokens_kwargs().get("thinking")


def test_canonical_hash_is_endpoint_independent():
    req = build_canonical(prompt="x")
    # the hash covers the shared core, not max_tokens
    assert req.canonical_hash() == build_canonical(prompt="x").canonical_hash()


# --- P0.2 counter cache isolation --------------------------------------------------------
class _FakeCountClient:
    def __init__(self, tokens):
        self._tokens = tokens
        self.messages = self

    def count_tokens(self, **kwargs):
        return type("R", (), {"input_tokens": self._tokens})()


def test_proxy_and_real_counters_do_not_share_cache():
    req = build_canonical(prompt="x")
    proxy = ProxyTokenCounter()
    real = AnthropicTokenCounter(_FakeCountClient(999), api_version="2023-06-01")
    pr = proxy.count(req)
    rr = real.count(req)
    assert pr.source == PROXY_SOURCE and rr.source == REAL_SOURCE
    assert rr.tokens == 999                                  # real value, NOT the proxy's
    assert pr.tokens != 999
    assert is_production_count(rr) and not is_production_count(pr)


def test_cache_entry_provenance_is_verified():
    req = build_canonical(prompt="x")
    proxy = ProxyTokenCounter()
    proxy.count(req)
    # corrupt the cache entry's source → a read must refuse to trust it
    key = next(iter(proxy._cache))
    proxy._cache[key] = proxy._cache[key].model_copy(update={"source": REAL_SOURCE})
    with pytest.raises(CounterProvenanceError):
        proxy.count(req)


# --- production-cap guard ----------------------------------------------------------------
def test_proxy_context_cap_is_not_production_valid():
    corpus = build_synthetic_corpus({"black-1": "whitespace"})
    rep = context_cap_preflight(corpus)                      # proxy source
    with pytest.raises(GateError):
        assert_context_cap_production_valid(rep)


def test_real_context_cap_passes_guard():
    corpus = build_synthetic_corpus({"black-1": "whitespace"})
    rep = context_cap_preflight(corpus, counter=AnthropicTokenCounter(_FakeCountClient(50)))
    assert rep.token_count_source == REAL_SOURCE
    assert_context_cap_production_valid(rep)                 # must not raise


# --- P0.3 Gate-2 training completeness ---------------------------------------------------
def test_training_incomplete_blocks_held_out():
    ids = ["t1", "t2", "t3"]
    with pytest.raises(GateError):
        assert_training_complete({"t1": "solver_pass", "t2": "incomplete", "t3": "solver_fail"}, ids)


def test_training_complete_passes():
    ids = ["t1", "t2"]
    assert_training_complete({"t1": "solver_pass", "t2": "solver_fail"}, ids)   # no raise


# --- P0.4 per-call runtime invariant -----------------------------------------------------
def _ok_ctx(**over):
    base = dict(fold=0, condition="C", is_held_out=True, request_tokens=1000, context_cap=4096,
                remaining_budget=1.0, max_call_cost=0.05, env_hash_expected="E",
                env_hash_actual="E", contract_expected="K", contract_actual="K",
                active_bank_hash="B", b1_mapping_bank_hash="B", b1_source=REAL_SOURCE,
                model_calls_used=0, max_model_calls=2, gate1_ok=True, gate2_ok=True,
                context_cap_source=REAL_SOURCE,
                pricing_artifact_hash_expected="PH", pricing_artifact_hash_actual="PH",
                endpoint_hash_expected="EH", endpoint_hash_actual="EH")
    base.update(over)
    return CallContext(**base)


def test_call_allowed_happy_path():
    assert_call_allowed(_ok_ctx())                           # must not raise


def test_call_blocked_on_oversize_request():
    with pytest.raises(GateError):
        assert_call_allowed(_ok_ctx(request_tokens=9999, context_cap=4096))


def test_call_blocked_on_stale_or_cross_fold_bank():
    with pytest.raises(GateError):
        assert_call_allowed(_ok_ctx(b1_mapping_bank_hash="OTHER"))


def test_call_blocked_on_proxy_b1_artifact():
    with pytest.raises(GateError):
        assert_call_allowed(_ok_ctx(b1_source=PROXY_SOURCE))


def test_call_blocked_on_wrong_environment():
    with pytest.raises(GateError):
        assert_call_allowed(_ok_ctx(env_hash_actual="DIFFERENT"))


def test_call_blocked_on_budget():
    with pytest.raises(GateError):
        assert_call_allowed(_ok_ctx(remaining_budget=0.01, max_call_cost=0.05))


def test_call_blocked_on_proxy_context_cap():
    with pytest.raises(GateError):
        assert_call_allowed(_ok_ctx(context_cap_source=PROXY_SOURCE))


def test_call_blocked_when_caps_exhausted():
    with pytest.raises(GateError):
        assert_call_allowed(_ok_ctx(model_calls_used=2, max_model_calls=2))


def test_held_out_requires_gate2():
    with pytest.raises(GateError):
        assert_call_allowed(_ok_ctx(gate2_ok=False))


# --- B1 production validity (stale / cross-fold / proxy) ----------------------------------
def _sel(fold=0, bank_hash="B", source=REAL_SOURCE):
    return B1Selection(fold=fold, token_count_source=source, c_bank_hash=bank_hash,
                       mapping={"a": "b"}, metrics=[], max_token_diff=0, sum_token_diff=0)


def test_b1_selection_rejects_proxy_stale_and_cross_fold():
    with pytest.raises(GateError):        # proxy
        assert_b1_selection_production_valid(_sel(source=PROXY_SOURCE), bank_hash="B", fold=0)
    with pytest.raises(GateError):        # cross-fold
        assert_b1_selection_production_valid(_sel(fold=1), bank_hash="B", fold=0)
    with pytest.raises(GateError):        # stale bank
        assert_b1_selection_production_valid(_sel(bank_hash="OLD"), bank_hash="NEW", fold=0)
    assert_b1_selection_production_valid(_sel(), bank_hash="B", fold=0)   # valid → no raise


# --- a5: pricing + endpoint binding is mandatory before a paid call -----------------------
def test_call_blocked_on_absent_or_drifted_a5_binding():
    with pytest.raises(GateError):        # pricing binding absent
        assert_call_allowed(_ok_ctx(pricing_artifact_hash_expected="",
                                    pricing_artifact_hash_actual=""))
    with pytest.raises(GateError):        # price drift since Gate 1
        assert_call_allowed(_ok_ctx(pricing_artifact_hash_actual="OTHER"))
    with pytest.raises(GateError):        # endpoint binding absent
        assert_call_allowed(_ok_ctx(endpoint_hash_expected="", endpoint_hash_actual=""))
    with pytest.raises(GateError):        # endpoint drift since Gate 1
        assert_call_allowed(_ok_ctx(endpoint_hash_actual="OTHER"))
