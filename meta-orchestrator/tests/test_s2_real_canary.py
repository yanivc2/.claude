"""RealTaskCanaryRunner — the four mandatory paid-path dry-runs, fake transport + offline ($0).

Proves the orchestration BEFORE any real messages.create: one atomic task-level reservation; R2 only
on a genuine public FAIL; exactly one hidden verify at the end; grant consume + completion; and the
AMBIGUOUS-after-send hold (reservation retained, grant not completed, no R2, no auto-retry).
"""
from __future__ import annotations

import json

import pytest

from meta_orchestrator.experiment.s2 import real_canary as RC
from meta_orchestrator.experiment.s2 import realtask as RT
from meta_orchestrator.experiment.s2.execution_grant import GrantUsageLedger, build_execution_grant
from meta_orchestrator.experiment.s2.endpoint import resolve_endpoint_attestation
from meta_orchestrator.experiment.s2.pricing import load_frozen_pricing
import os

CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")
MODEL = "claude-haiku-4-5-20251001"
ALLOWED = ["blib2to3/pgen2/driver.py"]
FIX = "### FILE: %s\n```python\ndef driver():\n    return 1\n```\n" % ALLOWED[0]


class FakeClient:
    """Scripted transport: each item is (text, in_tok, out_tok) or ('__RAISE__',) for ambiguity."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.i = 0
        self.sent = 0
        self.last_request_json = "{}"

    def build_request_messages(self, messages):
        kw = {"model": MODEL, "system": "s", "messages": list(messages),
              "thinking": {"type": "enabled", "budget_tokens": 1024}, "max_tokens": 4096}
        self.last_request_json = json.dumps(kw, sort_keys=True)
        return kw

    def complete_messages(self, messages):
        r = self.responses[self.i]; self.i += 1
        if r[0] == "__RAISE__":
            raise RuntimeError("ambiguous transport after send")
        self.sent += 1
        text, itok, otok = r

        class _R:
            pass
        _R.text, _R.input_tokens, _R.output_tokens = text, itok, otok
        _R.thinking_tokens, _R.returned_model = 0, MODEL
        return _R


def _ctx(tmp_path):
    repo = tmp_path / "repo"
    (repo / "blib2to3" / "pgen2").mkdir(parents=True, exist_ok=True)
    (repo / ALLOWED[0]).write_text("def driver():\n    return 0\n")
    return RT.RealTaskContext(task_id="black-112", repo=str(repo), py="python",
                              allowed_source_files=ALLOWED, p2p_nodes=["tests/test_black.py::t1"],
                              f2p_plan=[["tests/test_black.py", "comments2"]],
                              buggy_source={ALLOWED[0]: "def driver():\n    return 0\n"},
                              reference_fix={ALLOWED[0]: "def driver():\n    return 1\n"},
                              network_isolated=True)


def _grant(tmp_path):
    return build_execution_grant(grant_id="g-black-112", anchor_commit="HEAD",
                                 anchor_report_hash="rh", fold=1, condition="C", phase="training",
                                 task_id="black-112", curriculum_hash="cur", curriculum_position=0,
                                 max_total_exposure_usd="0.064282", granted_at="2026-07-19T00:00:00Z")


def _run(tmp_path, monkeypatch, *, responses, public_seq, hidden):
    ctx = _ctx(tmp_path)
    pub = {"i": 0}
    def fake_public(c):
        st = public_seq[min(pub["i"], len(public_seq) - 1)]; pub["i"] += 1
        return RT.PublicResult(status=st, passed=(st == "PASS"), tests_run=1,
                               sanitized_summary="" if st == "PASS" else "t1 FAILED: assert 0==1")
    monkeypatch.setattr(RT, "run_public_tests", fake_public)
    monkeypatch.setattr(RT, "hidden_verify", lambda c: hidden)
    pricing = load_frozen_pricing(CORPUS)
    ep = resolve_endpoint_attestation(provider=pricing.provider, model=pricing.model,
                                      env={"ANTHROPIC_BASE_URL": "https://api.anthropic.com"})
    return RC.run_real_task_canary(
        ctx, client=FakeClient(responses), statement="Fix it.", pricing=pricing, endpoint_att=ep,
        grant=_grant(tmp_path), grant_ledger_path=str(tmp_path / "grant_ledger.json"),
        work_dir=str(tmp_path / "canary"), count_fn=lambda kw: 100, full_exposure_usd="0.064282",
        fold_budget_usd=10.0, context_cap=57344, env_hash="e", contract_hash="k",
        memory_lines=[], is_train=True)


def test_scenario1_r1_success(tmp_path, monkeypatch):
    rep = _run(tmp_path, monkeypatch, responses=[(FIX, 50, 30)], public_seq=["PASS"], hidden=True)
    assert rep["public_statuses"] == ["PASS"] and rep["round2_opened"] is False
    assert rep["calls_sent"] == 1 and rep["grant_calls_used"] == 1 and rep["grant_completed"] is True
    assert rep["hidden_verdict"] is True and rep["reconciled_usd"] is not None
    assert rep["task_trace"][0] == "TASK_RESERVED" and rep["task_trace"][-1] == "TASK_CLOSED"
    assert rep["ambiguous_held"] is False and rep["task_2_started"] is False
    # the unused R2 portion of the reservation was released back to the budget
    assert rep["budget_available_after"] > 10.0 - float(rep["reserved_usd"])


def test_scenario2_r1_fail_then_r2(tmp_path, monkeypatch):
    rep = _run(tmp_path, monkeypatch, responses=[(FIX, 50, 30), (FIX, 60, 40)],
               public_seq=["FAIL", "PASS"], hidden=True)
    assert rep["public_statuses"] == ["FAIL", "PASS"] and rep["round2_opened"] is True
    assert rep["calls_sent"] == 2 and rep["grant_calls_used"] == 2 and rep["grant_completed"] is True
    assert rep["hidden_verdict"] is True


def test_scenario3_parser_or_patch_failure_no_r2(tmp_path, monkeypatch):
    # unparseable R1 → empty patch → source stays buggy → public PASS (P2P pass on buggy) → NO R2.
    rep = _run(tmp_path, monkeypatch, responses=[("no code here, just musing", 40, 20)],
               public_seq=["PASS"], hidden=False)
    assert rep["round2_opened"] is False and rep["calls_sent"] == 1
    assert rep["hidden_verdict"] is False              # unsolved → SOLVER_FAIL (one hidden verify)
    assert rep["grant_completed"] is True


def test_scenario4_ambiguous_after_send_holds(tmp_path, monkeypatch):
    rep = _run(tmp_path, monkeypatch, responses=[("__RAISE__",)], public_seq=["PASS"], hidden=True)
    assert rep["ambiguous_held"] is True and rep["round2_opened"] is False
    assert rep["hidden_verdict"] is None               # never verified
    assert rep["grant_completed"] is False             # grant NOT completed
    assert rep["reconciled_usd"] is None               # reservation RETAINED, not reconciled
    assert rep["budget_available_after"] <= 10.0 - float(rep["reserved_usd"]) + 1e-9  # still reserved
    assert rep["task_2_started"] is False


def test_no_double_reservation_single_task_hold(tmp_path, monkeypatch):
    """Exactly ONE reservation entry (task-level); the solver did not reserve per call."""
    rep = _run(tmp_path, monkeypatch, responses=[(FIX, 50, 30), (FIX, 60, 40)],
               public_seq=["FAIL", "PASS"], hidden=True)
    ledger = json.load(open(tmp_path / "canary" / "ledger.json"))
    assert len(ledger["entries"]) == 1                 # one task-level reservation for 2 calls
    assert ledger["entries"][0]["call_id"] == "task:black-112"
