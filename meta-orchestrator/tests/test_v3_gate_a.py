"""V3 Gate-A runner — SYNTHETIC/fixture tests (fake transport, $0). Proves the stateless
qualification runner: OLD and NEW contracts both drive a VALID_APPLIED_PATCH, memory/banking are
disabled, the model-identity gate fires, the grant phase binds, and outcomes seal — with NO API.
"""
from __future__ import annotations

import importlib.util
import json
import os

import pytest

from meta_orchestrator.experiment.s2 import realtask as RT
from meta_orchestrator.experiment.s2.execution_grant import build_execution_grant
from meta_orchestrator.experiment.s2.heldout_eval import SealedOutcomeStore
from meta_orchestrator.experiment.s2.pricing import load_frozen_pricing

_TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_TOOLS, name + ".py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


GA = _load("v3_gate_a")
CORPUS = os.path.join(os.path.dirname(_TOOLS), "corpus")
MODEL = "claude-haiku-4-5-20251001"
ALLOWED = ["m.py"]
BUGGY = "def f():\n    return 0\n"
FIXED = "def f():\n    return 1\n"

OLD_FIX = ("### PATCH\n### FILE: m.py\n<<<<<<< SEARCH\n    return 0\n=======\n    return 1\n"
           ">>>>>>> REPLACE\n### END")
NEW_FIX = json.dumps({"edits": [{"anchor": "    return 0", "replacement": "    return 1"}],
                      "done": True})


class FakeResp:
    def __init__(self, text):
        self.text, self.input_tokens, self.output_tokens = text, 100, 40
        self.stop_reason, self.returned_model = "end_turn", MODEL


class FakeClient:
    def __init__(self, texts):
        self.texts, self.i, self.sent = list(texts), 0, 0
        self.last_request_json = "{}"

    def build_request_messages(self, messages):
        return {"model": MODEL, "system": "s", "messages": list(messages),
                "thinking": {"type": "enabled", "budget_tokens": 1024}, "max_tokens": 11264}

    def complete_messages(self, messages):
        t = self.texts[self.i]; self.i += 1; self.sent += 1
        return FakeResp(t)


def _ctx(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "m.py").write_text(BUGGY)
    return RT.RealTaskContext(task_id="black-133", task_family="iterator", repo=str(repo),
                              py="python", allowed_source_files=ALLOWED,
                              p2p_nodes=["t.py::t1"], f2p_plan=[["t.py", "x"]],
                              buggy_source={"m.py": BUGGY}, reference_fix={"m.py": FIXED},
                              network_isolated=True)


def _grant(cell_index=0, task_id="black-133", phase=GA.GATE_A_PHASE):
    return build_execution_grant(grant_id=f"g-ga-{cell_index}", anchor_commit="HEAD",
                                 anchor_report_hash="rh", fold=1, condition="A", phase=phase,
                                 task_id=task_id, task_family="iterator", curriculum_hash="m",
                                 curriculum_position=cell_index, max_total_exposure_usd="0.19",
                                 granted_at="2026-07-22T00:00:00Z")


def _run(tmp_path, monkeypatch, contract, texts, *, public="PASS", hidden=True, grant=None,
         cell_index=0):
    ctx = _ctx(tmp_path)
    monkeypatch.setattr(RT, "run_public_tests",
                        lambda c: RT.PublicResult(status=public, passed=(public == "PASS"),
                                                  tests_run=1, sanitized_summary="t1 failed"))
    monkeypatch.setattr(RT, "hidden_verify", lambda c: hidden)
    store = SealedOutcomeStore(str(tmp_path / "sealed.jsonl"))
    red = GA.run_gate_a_cell(ctx, client=FakeClient(texts), contract=contract, statement="Fix.",
                             pricing=load_frozen_pricing(CORPUS), grant=grant or _grant(cell_index),
                             grant_ledger_path=str(tmp_path / "gl.json"),
                             work_dir=str(tmp_path / "cell"), full_exposure_usd="0.19",
                             fold_budget_usd=1.0, store=store, cell_index=cell_index)
    rec = store.outcome_table(unseal_reason="all_folds_complete")[0]["report"]
    return red, rec, ctx


def test_old_contract_valid_applied(tmp_path, monkeypatch):
    _, rec, ctx = _run(tmp_path, monkeypatch, "OLD", [OLD_FIX])
    assert rec["valid_applied_patch"] is True and rec["terminal_state"] == GA.VALID_APPLIED
    assert rec["hidden_verdict"] is True and rec["memory"] == "DISABLED"
    assert open(os.path.join(ctx.repo, "m.py")).read() == FIXED


def test_new_contract_valid_applied(tmp_path, monkeypatch):
    _, rec, ctx = _run(tmp_path, monkeypatch, "NEW", [NEW_FIX])
    assert rec["valid_applied_patch"] is True and rec["terminal_state"] == GA.VALID_APPLIED
    assert rec["hidden_verdict"] is True
    assert open(os.path.join(ctx.repo, "m.py")).read() == FIXED


def test_new_contract_malformed_is_not_valid_applied(tmp_path, monkeypatch):
    _, rec, ctx = _run(tmp_path, monkeypatch, "NEW", ["{ not json"])
    assert rec["valid_applied_patch"] is False and rec["terminal_state"].startswith("NEW_")
    assert rec["hidden_verdict"] is None
    assert open(os.path.join(ctx.repo, "m.py")).read() == BUGGY        # no write


def test_new_contract_ambiguous_anchor_fails_closed(tmp_path, monkeypatch):
    amb = json.dumps({"edits": [{"anchor": "return 0", "replacement": "return 1"}], "done": True})
    # "return 0" occurs once here, so make it ambiguous by a 2-line source:
    ctx = _ctx(tmp_path)
    (tmp_path / "repo" / "m.py").write_text("def f():\n    return 0\n\ndef g():\n    return 0\n")
    ctx = RT.RealTaskContext(task_id="black-133", task_family="iterator", repo=str(tmp_path / "repo"),
                             py="python", allowed_source_files=ALLOWED, p2p_nodes=["t.py::t1"],
                             f2p_plan=[["t.py", "x"]],
                             buggy_source={"m.py": "def f():\n    return 0\n\ndef g():\n    return 0\n"},
                             reference_fix={"m.py": FIXED}, network_isolated=True)
    monkeypatch.setattr(RT, "run_public_tests", lambda c: RT.PublicResult(status="PASS", passed=True, tests_run=1, sanitized_summary=""))
    monkeypatch.setattr(RT, "hidden_verify", lambda c: True)
    store = SealedOutcomeStore(str(tmp_path / "s.jsonl"))
    GA.run_gate_a_cell(ctx, client=FakeClient([amb]), contract="NEW", statement="Fix.",
                       pricing=load_frozen_pricing(CORPUS), grant=_grant(),
                       grant_ledger_path=str(tmp_path / "gl.json"), work_dir=str(tmp_path / "c"),
                       full_exposure_usd="0.19", fold_budget_usd=1.0, store=store, cell_index=0)
    rec = store.outcome_table(unseal_reason="all_folds_complete")[0]["report"]
    assert rec["valid_applied_patch"] is False and rec["terminal_state"] == "NEW_AMBIGUOUS"


def test_training_grant_rejected(tmp_path, monkeypatch):
    with pytest.raises(RuntimeError):
        _run(tmp_path, monkeypatch, "NEW", [NEW_FIX], grant=_grant(phase="training"))


def test_grant_not_bound_to_cell_rejected(tmp_path, monkeypatch):
    with pytest.raises(RuntimeError):
        _run(tmp_path, monkeypatch, "NEW", [NEW_FIX], grant=_grant(cell_index=5), cell_index=0)


def test_model_identity_gate(tmp_path):
    class BadBuilder:
        def build_request_messages(self, m):
            return {"model": "claude-opus-4-8", "max_tokens": 11264,
                    "thinking": {"budget_tokens": 1024}}
    with pytest.raises(RuntimeError):
        GA.assert_model_identity(BadBuilder(), load_frozen_pricing(CORPUS))


def test_manifest_18_cells_balanced_order():
    fam = {f"black-{i}": "iterator" for i in range(9)}
    man = GA.build_gate_a_manifest(fam)
    assert man["cell_count"] == 18 and man["n_tasks"] == 9
    assert man["memory"] == "DISABLED" and man["banking"] == "DISABLED"
    # each task appears once per contract
    for t in fam:
        cs = sorted(c["contract"] for c in man["cells"] if c["task_id"] == t)
        assert cs == ["NEW", "OLD"]
    # first-contract order alternates across tasks
    firsts = [next(c["contract"] for c in man["cells"] if c["task_id"] == t) for t in sorted(fam)]
    assert firsts[0] != firsts[1]                                      # balanced
    m2 = GA.build_gate_a_manifest(fam)
    assert man["content_hash"] == m2["content_hash"]                   # deterministic


def test_bank_and_lesson_writer_never_imported():
    import sys
    src = open(os.path.join(_TOOLS, "v3_gate_a.py")).read()
    assert "write_gate" not in src and "load_frozen_fold_bank" not in src
    assert "candidate_lesson" not in src                               # no lesson path
