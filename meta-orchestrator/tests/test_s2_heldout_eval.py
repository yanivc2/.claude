"""Held-out eval infrastructure ($0): condition memory, sealed outcomes, eval runner, zero-write.

Proves BEFORE any paid held-out call: the label-free per-condition memory resolution (B1
count-matched, D author-frozen-only, empty slots inject nothing); the sealed outcome store
(append-only hash chain, obfuscated payloads, visible-signal whitelist, unseal only under a
pre-declared reason); the frozen outcome-independent eval plan; and the runner's fail-closed
grant/phase/condition/bank bindings + zero-write + outcome redaction.
"""
from __future__ import annotations

import json
import os

import pytest

from meta_orchestrator.experiment.lesson import Lesson
from meta_orchestrator.experiment.s2 import heldout_eval as HE
from meta_orchestrator.experiment.s2 import realtask as RT
from meta_orchestrator.experiment.s2.endpoint import resolve_endpoint_attestation
from meta_orchestrator.experiment.s2.execution_grant import build_execution_grant
from meta_orchestrator.experiment.s2.gate_error import GateError
from meta_orchestrator.experiment.s2.memory import (FrozenLessonBank, MemoryFrozenError,
                                                    MemoryOccupancyMismatch, StaticPlaybook,
                                                    find_condition_label_leak)
from meta_orchestrator.experiment.s2.ordering import condition_order
from meta_orchestrator.experiment.s2.pricing import load_frozen_pricing

CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")
MODEL = "claude-haiku-4-5-20251001"
ALLOWED = ["blib2to3/pgen2/driver.py"]


def _l(fam, lid, n_rec=1):
    return Lesson(lesson_id=lid, task_family=fam,
                  recommended_action=[f"do thing {i}" for i in range(n_rec)], avoid=["avoid x"])


def _bank():
    return FrozenLessonBank(by_family={
        "whitespace": [_l("whitespace", "w1"), _l("whitespace", "w2")],
        "iterator": [_l("iterator", "i1"), _l("iterator", "i2")],
        "boundary": [_l("boundary", "b1")]}, frozen=True)


PLAYBOOK = StaticPlaybook(by_family={"whitespace": ["prefer minimal, targeted edits"],
                                     "parser_normalization": ["normalize before comparing"]},
                          author_frozen=True, author="external_model:test")


# --- resolve_eval_memory --------------------------------------------------------------------------

def test_condition_a_and_uncovered_c_inject_nothing():
    assert HE.resolve_eval_memory("A", "whitespace", bank=_bank()).payload == []
    em = HE.resolve_eval_memory("C", "parser_normalization", bank=_bank())   # family not in bank
    assert em.payload == [] and em.item_count == 0


def test_condition_c_payload_is_label_free_family_content():
    em = HE.resolve_eval_memory("C", "whitespace", bank=_bank())
    assert em.item_count == 2 and em.lesson_ids == ["w1", "w2"]
    assert em.payload and all(find_condition_label_leak(ln) is None for ln in em.payload)
    assert all(ln.startswith("- ") for ln in em.payload)     # label-free bullets only


def test_condition_b1_is_count_matched_from_non_target_family():
    em = HE.resolve_eval_memory("B1", "whitespace", bank=_bank())
    assert em.item_count == 2                                # matches C's 2 whitespace lessons
    assert em.source_family == "iterator"                    # the frozen primary derangement
    assert em.source_family != "whitespace"
    assert all(find_condition_label_leak(ln) is None for ln in em.payload)


def test_condition_b1_empty_c_slot_injects_nothing():
    em = HE.resolve_eval_memory("B1", "parser_normalization", bank=_bank())
    assert em.item_count == 0 and em.payload == []


def test_condition_b1_fails_closed_when_no_family_can_match():
    bank = FrozenLessonBank(by_family={"whitespace": [_l("whitespace", "w1"),
                                                      _l("whitespace", "w2"),
                                                      _l("whitespace", "w3")]}, frozen=True)
    with pytest.raises(MemoryOccupancyMismatch):
        HE.resolve_eval_memory("B1", "whitespace", bank=bank)   # nobody holds 3 lessons


def test_condition_d_requires_author_frozen_playbook():
    em = HE.resolve_eval_memory("D", "whitespace", bank=_bank(), playbook=PLAYBOOK)
    assert em.payload == ["- prefer minimal, targeted edits"]
    fixture = StaticPlaybook(by_family={"whitespace": ["x"]}, author_frozen=False)
    with pytest.raises(GateError):
        HE.resolve_eval_memory("D", "whitespace", bank=_bank(), playbook=fixture)
    with pytest.raises(GateError):
        HE.resolve_eval_memory("D", "whitespace", bank=_bank(), playbook=None)


def test_unknown_condition_rejected():
    with pytest.raises(GateError):
        HE.resolve_eval_memory("B2", "whitespace", bank=_bank())


# --- SealedOutcomeStore ---------------------------------------------------------------------------

def _store(tmp_path):
    return HE.SealedOutcomeStore(str(tmp_path / "sealed_outcomes.jsonl"))


def test_sealed_store_chain_and_tamper_detection(tmp_path):
    st = _store(tmp_path)
    st.record({"hidden_verdict": True}, task_id="t1", condition="A", rep=0,
              visible={"cost_usd": "0.01"})
    st.record({"hidden_verdict": False}, task_id="t1", condition="C", rep=0,
              visible={"cost_usd": "0.02"})
    assert st.verify_chain() == 2
    lines = open(st.path).read().splitlines()               # tamper: flip a payload byte
    e = json.loads(lines[0]); e["payload_b64"] = "QQ==" + e["payload_b64"][4:]
    open(st.path, "w").write(json.dumps(e, sort_keys=True) + "\n" + lines[1] + "\n")
    with pytest.raises(HE.SealedOutcomesError):
        st.verify_chain()


def test_sealed_store_outcomes_unreadable_without_predeclared_reason(tmp_path):
    st = _store(tmp_path)
    st.record({"hidden_verdict": True, "solver_outcome": "SOLVED"}, task_id="t1", condition="C",
              rep=0, visible={"cost_usd": "0.01", "infra_status": "ok"})
    with pytest.raises(HE.SealedOutcomesError):
        st.outcome_table(unseal_reason="progress_report")   # a peek is not a reason
    vis = st.visible_summaries()
    assert vis[0]["infra_status"] == "ok" and "hidden_verdict" not in vis[0]
    assert "SOLVED" not in open(st.path).read()             # obfuscated on disk (no casual read)
    table = st.outcome_table(unseal_reason=HE.UNSEAL_ALL_FOLDS_COMPLETE)
    assert table[0]["report"]["hidden_verdict"] is True     # decodes only under the frozen reason


def test_sealed_store_visible_whitelist_rejects_outcome_keys(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(HE.SealedOutcomesError):
        st.record({}, task_id="t", condition="A", rep=0, visible={"hidden_verdict": True})
    with pytest.raises(HE.SealedOutcomesError):
        st.record({}, task_id="t", condition="A", rep=0, visible={"anything_else": 1})
    assert st.count() == 0                                  # nothing was appended


# --- eval plan ------------------------------------------------------------------------------------

HELD = {"black-133": "iterator", "black-1632": "whitespace", "black-60": "whitespace"}


def test_eval_plan_structure_and_determinism():
    p1 = HE.build_eval_plan(HELD, heldout_fold_index=1, bank_content_hash="513d63007784")
    p2 = HE.build_eval_plan(HELD, heldout_fold_index=1, bank_content_hash="513d63007784")
    assert p1.content_hash() == p2.content_hash()           # outcome-independent + deterministic
    primary = [e for e in p1.entries if e.role == "primary"]
    stability = [e for e in p1.entries if e.role == "stability"]
    assert len(primary) == 12 and len(stability) == 6       # 3×4 + 3×2
    for tid in HELD:                                        # Latin-square rotation per task
        conds = [e.condition for e in primary if e.task_id == tid]
        assert conds == condition_order(tid)
    assert all(e.rep == 1 and e.condition in ("A", "C") for e in stability)


# --- runner (fake transport, $0) ------------------------------------------------------------------

FIX = ("### PATCH\n### FILE: " + ALLOWED[0] +
       "\n<<<<<<< SEARCH\n    return 0\n=======\n    return 1\n>>>>>>> REPLACE\n### END")


class FakeClient:
    def __init__(self, responses):
        self.responses = list(responses); self.i = 0; self.sent = 0
        self.last_request_json = "{}"

    def build_request_messages(self, messages):
        kw = {"model": MODEL, "system": "s", "messages": list(messages),
              "thinking": {"type": "enabled", "budget_tokens": 1024}, "max_tokens": 4096}
        self.last_request_json = json.dumps(kw, sort_keys=True)
        return kw

    def complete_messages(self, messages):
        r = self.responses[self.i]; self.i += 1; self.sent += 1
        text, itok, otok = r[0], r[1], r[2]

        class _R:
            pass
        _R.text, _R.input_tokens, _R.output_tokens = text, itok, otok
        _R.thinking_tokens, _R.returned_model = None, MODEL
        _R.stop_reason, _R.stop_sequence, _R.content_block_types = "end_turn", None, ["text"]
        _R.visible_text_length, _R.visible_text_sha256 = len(text), ""
        return _R


def _ctx(tmp_path):
    repo = tmp_path / "repo"
    (repo / "blib2to3" / "pgen2").mkdir(parents=True, exist_ok=True)
    (repo / ALLOWED[0]).write_text("def driver():\n    return 0\n")
    return RT.RealTaskContext(task_id="black-1632", task_family="whitespace", repo=str(repo),
                              py="python", allowed_source_files=ALLOWED,
                              p2p_nodes=["tests/test_black.py::t1"],
                              f2p_plan=[["tests/test_black.py", "comments2"]],
                              buggy_source={ALLOWED[0]: "def driver():\n    return 0\n"},
                              reference_fix={ALLOWED[0]: "def driver():\n    return 1\n"},
                              network_isolated=True)


def _grant(*, condition="C", phase=HE.EVAL_PHASE, task_id="black-1632"):
    return build_execution_grant(grant_id=f"g-eval-{condition}", anchor_commit="HEAD",
                                 anchor_report_hash="rh", fold=1, condition=condition, phase=phase,
                                 task_id=task_id, task_family="whitespace",
                                 curriculum_hash="cur", curriculum_position=0,
                                 max_total_exposure_usd="0.064282",
                                 granted_at="2026-07-21T00:00:00Z")


def _run(tmp_path, monkeypatch, *, condition="C", grant=None, client=None, rep=0, bank=None):
    ctx = _ctx(tmp_path)
    monkeypatch.setattr(RT, "run_public_tests",
                        lambda c: RT.PublicResult(status="PASS", passed=True, tests_run=1,
                                                  sanitized_summary=""))
    monkeypatch.setattr(RT, "hidden_verify", lambda c: True)
    pricing = load_frozen_pricing(CORPUS)
    ep = resolve_endpoint_attestation(provider=pricing.provider, model=pricing.model,
                                      env={"ANTHROPIC_BASE_URL": "https://api.anthropic.com"})
    bank = bank or _bank()
    store = HE.SealedOutcomeStore(str(tmp_path / "sealed.jsonl"))
    red = HE.run_heldout_eval_task(
        ctx, client=client or FakeClient([(FIX, 100, 50)]), statement="Fix it.", pricing=pricing,
        endpoint_att=ep, grant=grant or _grant(condition=condition),
        grant_ledger_path=str(tmp_path / "gl.json"), work_dir=str(tmp_path / "eval"),
        count_fn=lambda kw: 100, full_exposure_usd="0.064282", fold_budget_usd=10.0,
        context_cap=57344, env_hash="e", contract_hash="k", condition=condition, bank=bank,
        playbook=PLAYBOOK, store=store, rep=rep, expected_bank_hash=bank.content_hash(),
        forbidden_values=[])
    return red, store, bank


def test_eval_run_zero_write_and_redacted_report(tmp_path, monkeypatch):
    red, store, bank = _run(tmp_path, monkeypatch, condition="C")
    # the caller-facing report carries NO outcome field
    assert set(red) & HE.FORBIDDEN_OUTCOME_KEYS == set()
    assert "hidden_verdict" not in red and red["infra_status"] == "ok"
    assert red["grant_completed"] is True and red["calls_sent"] == 1
    # the FULL outcome is sealed (and only opens under a pre-declared reason)
    assert store.count() == 1
    with pytest.raises(HE.SealedOutcomesError):
        store.outcome_table(unseal_reason="curiosity")
    rep = store.outcome_table(unseal_reason=HE.UNSEAL_ALL_FOLDS_COMPLETE)[0]["report"]
    assert rep["hidden_verdict"] is True and rep["write_gate_written"] == 0
    assert rep["memory_telemetry"]["condition"] == "C"
    assert rep["bank_hash"] == bank.content_hash()          # bank untouched


def test_eval_grant_condition_mismatch_blocks_before_send(tmp_path, monkeypatch):
    client = FakeClient([(FIX, 100, 50)])
    with pytest.raises(GateError):
        _run(tmp_path, monkeypatch, condition="A", grant=_grant(condition="C"), client=client)
    assert client.sent == 0                                 # blocked before any transport


def test_eval_training_grant_rejected(tmp_path, monkeypatch):
    client = FakeClient([(FIX, 100, 50)])
    with pytest.raises(GateError):
        _run(tmp_path, monkeypatch, condition="C",
             grant=_grant(condition="C", phase="training"), client=client)
    assert client.sent == 0


def test_eval_stability_rep_is_ac_only(tmp_path, monkeypatch):
    client = FakeClient([(FIX, 100, 50)])
    with pytest.raises(GateError):
        _run(tmp_path, monkeypatch, condition="D", rep=1, client=client)
    assert client.sent == 0


def test_eval_bank_hash_mismatch_blocks_before_send(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    pricing = load_frozen_pricing(CORPUS)
    ep = resolve_endpoint_attestation(provider=pricing.provider, model=pricing.model,
                                      env={"ANTHROPIC_BASE_URL": "https://api.anthropic.com"})
    client = FakeClient([(FIX, 100, 50)])
    with pytest.raises(GateError):
        HE.run_heldout_eval_task(
            ctx, client=client, statement="s", pricing=pricing, endpoint_att=ep,
            grant=_grant(), grant_ledger_path=str(tmp_path / "gl.json"),
            work_dir=str(tmp_path / "eval"), count_fn=lambda kw: 100,
            full_exposure_usd="0.064282", fold_budget_usd=10.0, context_cap=57344,
            env_hash="e", contract_hash="k", condition="C", bank=_bank(), playbook=PLAYBOOK,
            store=HE.SealedOutcomeStore(str(tmp_path / "s.jsonl")),
            expected_bank_hash="deadbeefdead", forbidden_values=[])
    assert client.sent == 0


def test_frozen_bank_refuses_writes_during_heldout():
    with pytest.raises(MemoryFrozenError):
        _bank().add("whitespace", _l("whitespace", "w9"))
