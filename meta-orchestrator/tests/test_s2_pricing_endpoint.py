"""a5: frozen-pricing + endpoint binding. Every cost figure derives from ONE Decimal artifact, and
a price / model / provider / endpoint change blocks the paid call instead of proceeding on the old
estimate.

Pure/offline. Covers the six mandatory block cases the operator enumerated:
  input price change · output price change · alternate ANTHROPIC_BASE_URL · different host ·
  different model · projection not derived from the artifact / stale artifact hash.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from meta_orchestrator.experiment.s2 import (CallContext, EndpointAttestation, EndpointEvidence,
                                             GateError, PricingArtifact, PricingDerivationSample,
                                             PricingEvidence, assert_call_allowed,
                                             assert_endpoint_approved, assert_pricing_matches,
                                             build_pricing_artifact, call_cost_usd,
                                             load_frozen_pricing, max_call_cost_usd,
                                             resolve_endpoint_attestation, verify_endpoint_evidence,
                                             verify_pricing_evidence)
from meta_orchestrator.experiment.s2.contract_s2 import S2_EXACT_MODEL_ID

CORPUS = "corpus"
APPROVED_ENV = {"ANTHROPIC_BASE_URL": "https://api.anthropic.com"}


def _art(**over) -> PricingArtifact:
    base = dict(provider="anthropic", model=S2_EXACT_MODEL_ID, input_usd_per_mtok="1.00",
                output_usd_per_mtok="5.00", pricing_source="official_anthropic_pricing",
                pricing_verified_at="2026-07-19")
    base.update(over)
    return build_pricing_artifact(**base)


# --- the frozen artifact is the single source of Decimal truth ----------------------------
def test_frozen_artifact_loads_and_derives_exact_decimal_cost():
    art = load_frozen_pricing(CORPUS)
    assert art.model == S2_EXACT_MODEL_ID and art.provider == "anthropic"
    # $1/MTok in, $5/MTok out — exact Decimal, no float drift
    assert call_cost_usd(art, input_tokens=54472, output_tokens=4096) == Decimal("0.074952")
    assert max_call_cost_usd(art, input_tokens=1_000_000, max_output_tokens=1_000_000) == Decimal("6")


def test_stale_or_tampered_artifact_hash_blocks(tmp_path):
    import json
    bad = _art().model_dump()
    bad["input_usd_per_mtok"] = "2.00"                 # edit price but keep the old content_hash
    p = tmp_path / "s2_pricing.frozen.json"
    p.write_text(json.dumps(bad))
    with pytest.raises(GateError):
        load_frozen_pricing(str(tmp_path))


def test_assert_pricing_matches_blocks_on_each_drift():
    art = _art()
    ok = dict(expected_hash=art.content_hash, expected_input_usd_per_mtok="1.00",
              expected_output_usd_per_mtok="5.00", expected_model=S2_EXACT_MODEL_ID,
              expected_provider="anthropic")
    assert_pricing_matches(art, **ok)                  # no raise
    for bad in (dict(expected_input_usd_per_mtok="1.01"), dict(expected_output_usd_per_mtok="4.99"),
                dict(expected_model="claude-opus-4-8"), dict(expected_provider="bedrock"),
                dict(expected_hash="deadbeef")):
        kw = dict(ok); kw.update(bad)
        with pytest.raises(GateError):
            assert_pricing_matches(art, **kw)


# --- endpoint binding ---------------------------------------------------------------------
def test_endpoint_approved_only_for_exact_host():
    art = load_frozen_pricing(CORPUS)
    att = resolve_endpoint_attestation(provider="anthropic", model=art.model, env=APPROVED_ENV)
    assert_endpoint_approved(att, art)                 # approved host, no raise


def test_alternate_base_url_blocks():
    art = load_frozen_pricing(CORPUS)
    att = resolve_endpoint_attestation(provider="anthropic", model=art.model,
                                       env={"ANTHROPIC_BASE_URL": "https://evil.example.com"})
    with pytest.raises(GateError):
        assert_endpoint_approved(att, art)


def test_bedrock_vertex_switch_blocks():
    art = load_frozen_pricing(CORPUS)
    att = resolve_endpoint_attestation(provider="anthropic", model=art.model,
                                       env={"ANTHROPIC_BASE_URL": "https://api.anthropic.com",
                                            "CLAUDE_CODE_USE_BEDROCK": "1"})
    with pytest.raises(GateError):
        assert_endpoint_approved(att, art)


def test_endpoint_model_mismatch_blocks():
    art = load_frozen_pricing(CORPUS)
    att = resolve_endpoint_attestation(provider="anthropic", model="claude-opus-4-8",
                                       env=APPROVED_ENV)
    with pytest.raises(GateError):
        assert_endpoint_approved(att, art)


def test_non_https_scheme_blocks():
    art = load_frozen_pricing(CORPUS)
    att = resolve_endpoint_attestation(provider="anthropic", model=art.model,
                                       env={"ANTHROPIC_BASE_URL": "http://api.anthropic.com"})
    with pytest.raises(GateError):
        assert_endpoint_approved(att, art)


# --- gate-derived evidence predicates -----------------------------------------------------
def _pricing_ev(**over) -> PricingEvidence:
    art = load_frozen_pricing(CORPUS)
    cost = call_cost_usd(art, input_tokens=54472, output_tokens=4096)
    base = dict(pricing_artifact_hash=art.content_hash, input_usd_per_mtok="1.00",
                output_usd_per_mtok="5.00",
                samples=[PricingDerivationSample(input_tokens=54472, output_tokens=4096,
                                                 claimed_cost_usd=str(cost))])
    base.update(over)
    return PricingEvidence(**base)


def test_pricing_evidence_ok_when_derived_from_artifact():
    p = verify_pricing_evidence(_pricing_ev(), corpus_dir=CORPUS, expected_model=S2_EXACT_MODEL_ID,
                                expected_provider="anthropic")
    assert p.ok, p.reasons


def test_pricing_evidence_blocks_cost_not_derived_from_artifact():
    bad = _pricing_ev(samples=[PricingDerivationSample(input_tokens=54472, output_tokens=4096,
                                                       claimed_cost_usd="0.05")])   # wrong figure
    p = verify_pricing_evidence(bad, corpus_dir=CORPUS, expected_model=S2_EXACT_MODEL_ID,
                                expected_provider="anthropic")
    assert not p.ok and any("cost_not_derived" in r for r in p.reasons)


def test_pricing_evidence_blocks_hash_or_price_mismatch():
    assert not verify_pricing_evidence(_pricing_ev(pricing_artifact_hash="deadbeef"),
                                       corpus_dir=CORPUS, expected_model=S2_EXACT_MODEL_ID,
                                       expected_provider="anthropic").ok
    assert not verify_pricing_evidence(_pricing_ev(input_usd_per_mtok="2.00"), corpus_dir=CORPUS,
                                       expected_model=S2_EXACT_MODEL_ID,
                                       expected_provider="anthropic").ok


def test_endpoint_evidence_ok_and_blocked():
    art = load_frozen_pricing(CORPUS)
    good = resolve_endpoint_attestation(provider="anthropic", model=art.model, env=APPROVED_ENV)
    assert verify_endpoint_evidence(EndpointEvidence(attestation=good.model_dump()),
                                    corpus_dir=CORPUS).ok
    bad = resolve_endpoint_attestation(provider="anthropic", model=art.model,
                                       env={"ANTHROPIC_BASE_URL": "https://evil.example.com"})
    assert not verify_endpoint_evidence(EndpointEvidence(attestation=bad.model_dump()),
                                        corpus_dir=CORPUS).ok


# --- runtime guard: a5 binding is mandatory before a paid call ----------------------------
def _ctx(**over) -> CallContext:
    base = dict(fold=1, condition="C", is_held_out=False, request_tokens=100, context_cap=60416,
                remaining_budget=10.0, max_call_cost=0.075, env_hash_expected="e",
                env_hash_actual="e", contract_expected="k", contract_actual="k",
                active_bank_hash="b", model_calls_used=0, max_model_calls=2, gate1_ok=True,
                gate2_ok=True, context_cap_source="anthropic_count_tokens",
                pricing_artifact_hash_expected="ph", pricing_artifact_hash_actual="ph",
                endpoint_hash_expected="eh", endpoint_hash_actual="eh")
    base.update(over)
    return CallContext(**base)


def test_call_allowed_with_bound_pricing_and_endpoint():
    assert_call_allowed(_ctx())                        # no raise


def test_call_blocked_on_missing_or_drifted_binding():
    with pytest.raises(GateError):                     # binding absent
        assert_call_allowed(_ctx(pricing_artifact_hash_actual="", pricing_artifact_hash_expected=""))
    with pytest.raises(GateError):                     # price drift
        assert_call_allowed(_ctx(pricing_artifact_hash_actual="OTHER"))
    with pytest.raises(GateError):                     # endpoint drift
        assert_call_allowed(_ctx(endpoint_hash_actual="OTHER"))
    with pytest.raises(GateError):                     # endpoint binding absent
        assert_call_allowed(_ctx(endpoint_hash_expected="", endpoint_hash_actual=""))
