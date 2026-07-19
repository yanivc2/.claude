"""Offline tests for the thin Gate-1 evidence runner (deterministic fake count_fn / builder).

The fake ``count_fn`` counts DISTINCT whitespace tokens, which reproduces the property that matters:
a degenerate repeated filler collapses to ~1 token (under-counts) while the diverse envelope grows
with content. Real ``count_tokens`` (BPE) behaves the same way; here it is deterministic + offline.
"""
from __future__ import annotations

import json

import pytest

from meta_orchestrator.experiment.s2 import gate1_runner as G
from meta_orchestrator.experiment.s2.canary_prompt import build_r1_worstcase_prompt
from meta_orchestrator.experiment.s2.contract_s2 import S2_MAX_TOKENS
from meta_orchestrator.experiment.s2.endpoint import resolve_endpoint_attestation
from meta_orchestrator.experiment.s2.evidence import PytestEvidence

MODEL = "claude-haiku-4-5-20251001"
_CORPUS_DIR = None  # set in conftest-like fixture below


class FakeBuilder:
    def build_request_messages(self, messages):
        return {"model": MODEL, "system": "S2 system prompt",
                "thinking": {"type": "enabled", "budget_tokens": 1024},
                "messages": list(messages), "max_tokens": S2_MAX_TOKENS}


def distinct_token_count(kwargs) -> int:
    return len(set(json.dumps(kwargs, sort_keys=True).split()))


ALLOWED = ["pkg/mod_a.py", "pkg/mod_b.py"]
STATEMENT = "The parser mishandles trailing whitespace on continuation lines; fix the target files."


def _r1():
    return build_r1_worstcase_prompt(STATEMENT, {p: f"# src {p}\ndef f():\n    return 0\n"
                                                 for p in ALLOWED}, train=True)


def test_envelope_reaches_floor_minimal_and_parser_valid():
    b, cf = FakeBuilder(), distinct_token_count
    m = G._size_envelope(b, cf, task_id="t1", r1_prompt=_r1(), feedback=G.worst_public_feedback(),
                         allowed=ALLOWED, task_family="whitespace", train=True)
    assert m.assistant_input_delta >= G.ENVELOPE_FLOOR          # reaches the 4096 floor
    assert m.overshoot <= G.MAX_ENVELOPE_OVERSHOOT              # minimal-unit search → small overshoot
    assert m.parser_valid is True
    # minimality: one unit fewer would be below the floor
    smaller = G.measure_assistant_delta(
        b, cf, r1_prompt=_r1(), feedback=G.worst_public_feedback(),
        assistant_text=__import__("meta_orchestrator.experiment.s2.canary_prompt", fromlist=["x"])
        .max_r1_assistant_envelope(ALLOWED, train=True, units=m.units - 1))
    assert smaller < G.ENVELOPE_FLOOR


def test_degenerate_filler_undercounts_and_would_block():
    """The negative test: 'O'*16384 collapses under the tokenizer -> delta < floor -> blocked."""
    b, cf = FakeBuilder(), distinct_token_count
    degenerate = "O" * 16384
    d = G.measure_assistant_delta(b, cf, r1_prompt=_r1(), feedback=G.worst_public_feedback(),
                                  assistant_text=degenerate)
    assert d < G.ENVELOPE_FLOOR                                 # the under-count the guard must catch
    # the real envelope, same count_fn, clears the floor — proving the guard discriminates
    good = G._size_envelope(b, cf, task_id="t1", r1_prompt=_r1(), feedback=G.worst_public_feedback(),
                            allowed=ALLOWED, task_family="whitespace", train=True)
    assert good.assistant_input_delta >= G.ENVELOPE_FLOOR


def _endpoint_att():
    import anthropic
    client = anthropic.Anthropic(api_key="x", base_url="https://api.anthropic.com", max_retries=0)
    return resolve_endpoint_attestation(provider="anthropic", model=MODEL, client=client).model_dump()


def _good_pytest_ev(env_hash, required):
    return PytestEvidence(run_id="gate1-offline", environment_hash=env_hash, git_commit="HEAD",
                          exit_code=0, failed=0, skipped=0, passed_node_ids=list(required),
                          sdk_version="0.117.0", httpx_version="0.28.1", command_hash="c").sealed()


def _corpus_dir():
    import os
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def _write_inputs(tmp_path, folds):
    tasks = {}
    scope_tasks = []
    for i, fold in enumerate(folds):
        tid = f"black-{i}"
        tasks[tid] = {"repo_url": "https://github.com/psf/black", "buggy_rev": "rev",
                      "allowed_source_files": ALLOWED, "buggy_source_hash": "h",
                      "sanitized_statement": STATEMENT, "family": "whitespace"}
        scope_tasks.append({"task_id": tid, "fold": fold})
    cj = tmp_path / "corpus.json"
    cj.write_text(json.dumps({"tasks": tasks}))
    sj = tmp_path / "scope.json"
    sj.write_text(json.dumps({"tasks": scope_tasks}))
    return str(cj), str(sj), list(tasks)


def test_run_gate1_passes_with_good_evidence(tmp_path, monkeypatch):
    ids_folds = [0, 0, 0, 1, 1, 1, 2, 2, 2]
    cj, sj, ids = _write_inputs(tmp_path, ids_folds)
    sources = {tid: {p: f"# {p}\ndef f():\n    return 0\n" for p in ALLOWED} for tid in ids}
    from meta_orchestrator.experiment.s2.materialize import MaterializationReport
    rep = MaterializationReport(corpus_manifest_sha256="m", dataset_commit="d", n_tasks=len(ids),
                                n_files=len(ids) * 2, all_verified=True, cache_dir="x",
                                cache_index_hash="idx")
    monkeypatch.setattr(G, "materialize_buggy_sources", lambda *a, **k: (sources, rep))

    from meta_orchestrator.experiment.s2.budget_policy import ReportedCredits
    required = ["tests/test_s2_prepaid.py::test_sdk_serialized_body_omits_effort_and_temperature"]
    art = G.run_gate1(corpus_json_path=cj, scope_json_path=sj, corpus_dir=_corpus_dir(),
                      cache_dir=str(tmp_path / "cache"), request_builder=FakeBuilder(),
                      count_fn=distinct_token_count, model=MODEL, count_model=MODEL,
                      endpoint_attestation=_endpoint_att(),
                      pytest_ev=_good_pytest_ev("envhash", required), env_hash="envhash",
                      reported_credits=ReportedCredits(available_api_credits_usd="4.75"),
                      run_id="gate1-offline", git_commit="HEAD",
                      required_node_ids=required, heldout_fold=1)

    assert art.blocking_notes == []
    assert art.context_cap % 1024 == 0 and art.context_cap + S2_MAX_TOKENS <= 200_000
    assert art.max_overshoot_seen <= G.MAX_ENVELOPE_OVERSHOOT
    assert len(art.train_task_ids) == 6                        # 9 tasks, held-out fold 1 (3) → 6 train
    # approved caps bound from the frozen policy; both projections fit; credits recorded separately
    assert art.budget_policy["fold1_hard_cap_usd"] == "10.00"
    assert art.budget_policy["global_hard_cap_usd"] == "30.00"
    assert art.budget_policy_hash and art.reported_credits["is_budget_cap"] is False
    assert art.experiment_projection["worst_multiplier"] == 8
    assert art.gate_report["production_valid"] is True
    assert art.gate_report["passed"] is True                  # good evidence → PASS
    assert art.gate_report["token_count_source"] == "anthropic_count_tokens"


def test_run_gate1_blocks_on_unverified_materialization(tmp_path, monkeypatch):
    cj, sj, ids = _write_inputs(tmp_path, [0, 1, 2])
    from meta_orchestrator.experiment.s2.materialize import MaterializationReport
    rep = MaterializationReport(corpus_manifest_sha256="m", dataset_commit="d", n_tasks=3, n_files=0,
                                all_verified=False, cache_dir="x", cache_index_hash="idx",
                                mismatches=["black-0:hash aa!=bb"])
    monkeypatch.setattr(G, "materialize_buggy_sources", lambda *a, **k: ({}, rep))
    from meta_orchestrator.experiment.s2.budget_policy import ReportedCredits
    art = G.run_gate1(corpus_json_path=cj, scope_json_path=sj, corpus_dir=_corpus_dir(),
                      cache_dir=str(tmp_path / "cache"), request_builder=FakeBuilder(),
                      count_fn=distinct_token_count, model=MODEL, count_model=MODEL,
                      endpoint_attestation=_endpoint_att(),
                      pytest_ev=_good_pytest_ev("envhash", []), env_hash="envhash",
                      reported_credits=ReportedCredits(available_api_credits_usd="4.75"),
                      run_id="g", git_commit="HEAD", required_node_ids=[], heldout_fold=1)
    assert any("materialization_unverified" in n for n in art.blocking_notes)
