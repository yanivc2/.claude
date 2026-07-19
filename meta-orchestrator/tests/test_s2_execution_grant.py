"""P0.5 execution grant — a passed Gate 1 authorizes the DESIGN, never spending ($0, offline).

Proves the machine enforcement the operator required: a valid Gate-1 authorization WITHOUT a live,
task-scoped execution grant blocks every messages.create (fail-closed).
"""
from __future__ import annotations

import json

import pytest

from meta_orchestrator.experiment.s2.execution_grant import (GrantUsageLedger,
                                                             build_execution_grant)
from meta_orchestrator.experiment.s2.gates import GateError, assert_call_allowed
from meta_orchestrator.experiment.s2.live_solver import ModelBackedRoundSolver
from meta_orchestrator.experiment.s2.call_journal import BudgetLedger, CallJournal
from meta_orchestrator.experiment.s2.pricing import load_frozen_pricing
from meta_orchestrator.experiment.s2.endpoint import resolve_endpoint_attestation
from meta_orchestrator.experiment.s2.solver import RoundView
import os

CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def _grant(**over):
    base = dict(grant_id="g-black-1", anchor_commit="752f60d", anchor_report_hash="bbb3a57fb695",
                fold=1, condition="C", phase="training", task_id="black-1", curriculum_hash="cur",
                curriculum_position=0, granted_at="2026-07-19T00:00:00Z")
    base.update(over)
    return build_execution_grant(**base)


def test_grant_covers_only_its_exact_scope():
    g = _grant()
    assert g.covers(fold=1, condition="C", task_id="black-1", calls_used=0)
    assert g.covers(fold=1, condition="C", task_id="black-1", calls_used=1)      # R2 still in scope
    assert not g.covers(fold=1, condition="C", task_id="black-1", calls_used=2)  # call cap reached
    assert not g.covers(fold=2, condition="C", task_id="black-1", calls_used=0)  # wrong fold
    assert not g.covers(fold=1, condition="A", task_id="black-1", calls_used=0)  # wrong condition
    assert not g.covers(fold=1, condition="C", task_id="black-2", calls_used=0)  # wrong task


def test_tampered_grant_is_not_sealed_and_covers_nothing():
    g = _grant()
    tampered = g.model_copy(update={"max_messages_calls": 999})   # widen the cap, keep old hash
    assert not tampered.is_sealed()
    assert not tampered.covers(fold=1, condition="C", task_id="black-1", calls_used=0)


class _RecordingClient:
    """Records every complete_messages call so a test can prove NO paid call was made."""

    def __init__(self):
        self.sent = 0
        self.last_request_json = "{}"

    def build_request_messages(self, messages):
        kwargs = {"model": "claude-haiku-4-5-20251001", "system": "s", "messages": list(messages),
                  "thinking": {"type": "enabled", "budget_tokens": 1024}, "max_tokens": 4096}
        self.last_request_json = json.dumps(kwargs, sort_keys=True)
        return kwargs

    def complete_messages(self, messages):
        self.sent += 1
        class _R:
            text = "### FILE: solution.py\n```python\nx = 1\n```\n"
            input_tokens = 10
            output_tokens = 5
            thinking_tokens = 0
            returned_model = "claude-haiku-4-5-20251001"
        return _R()


def _solver(tmp_path, client, *, grant, grant_ledger="__auto__"):
    pricing = load_frozen_pricing(CORPUS)
    ep = resolve_endpoint_attestation(provider=pricing.provider, model=pricing.model,
                                      env={"ANTHROPIC_BASE_URL": "https://api.anthropic.com"})
    if grant_ledger == "__auto__":
        grant_ledger = GrantUsageLedger(str(tmp_path / "grant_ledger.json")) if grant else None
    return ModelBackedRoundSolver(
        client=client, statement="s", allowed_source_files=["solution.py"], task_family="whitespace",
        is_train=True, pricing=pricing, endpoint_att=ep,
        ledger=BudgetLedger(str(tmp_path / "l.json"), total_budget=10.0),
        journal=CallJournal(str(tmp_path / "j.jsonl")), fold=1, condition="C", context_cap=60416,
        count_fn=lambda kw: 100, run_id="grant-test", env_hash="e", contract_hash="k",
        active_bank_hash="b", task_id="black-1", execution_grant=grant, grant_ledger=grant_ledger)


def test_persistent_ledger_is_non_replayable_and_restart_safe(tmp_path):
    """call 1 & 2 allowed; call 3 blocked (cap 2); replay after completion blocked; restart persists."""
    g = _grant()
    path = str(tmp_path / "gl.json")
    led = GrantUsageLedger(path)
    assert led.authorize_and_record(g, fold=1, condition="C", task_id="black-1") == 1
    assert led.authorize_and_record(g, fold=1, condition="C", task_id="black-1") == 2
    with pytest.raises(GateError):                               # call 3 > max_messages_calls(2)
        led.authorize_and_record(g, fold=1, condition="C", task_id="black-1")
    # a fresh ledger over the SAME file (process restart) still sees 2 and still blocks
    assert GrantUsageLedger(path).calls_used(g.grant_id) == 2
    with pytest.raises(GateError):
        GrantUsageLedger(path).authorize_and_record(g, fold=1, condition="C", task_id="black-1")


def test_completed_grant_cannot_be_replayed(tmp_path):
    g = _grant()
    path = str(tmp_path / "gl.json")
    led = GrantUsageLedger(path)
    led.authorize_and_record(g, fold=1, condition="C", task_id="black-1")
    led.mark_complete(g)
    assert GrantUsageLedger(path).is_completed(g.grant_id)       # survives restart
    with pytest.raises(GateError):                               # replay after completion → blocked
        GrantUsageLedger(path).authorize_and_record(g, fold=1, condition="C", task_id="black-1")


def test_ledger_blocks_wrong_task_and_task2(tmp_path):
    g = _grant(task_id="black-1")
    led = GrantUsageLedger(str(tmp_path / "gl.json"))
    with pytest.raises(GateError):                               # task 2 is never authorized
        led.authorize_and_record(g, fold=1, condition="C", task_id="black-2")
    assert g.task_2_authorized is False


def _view():
    return RoundView(round_index=1, task_id="black-1", task_family="whitespace",
                     source={"solution.py": "x=1"}, public_tests={}, memory_lines=[])


def test_paid_call_blocked_without_grant_and_client_never_called(tmp_path):
    client = _RecordingClient()
    solver = _solver(tmp_path, client, grant=None)               # anchor valid, NO grant
    with pytest.raises(GateError):
        solver.solve_round(_view())
    assert client.sent == 0                                       # NOTHING was sent — fail-closed


def test_paid_call_blocked_when_grant_targets_a_different_task(tmp_path):
    client = _RecordingClient()
    solver = _solver(tmp_path, client, grant=_grant(task_id="black-2"))   # grant for another task
    with pytest.raises(GateError):
        solver.solve_round(_view())
    assert client.sent == 0


def test_paid_call_proceeds_with_matching_grant(tmp_path):
    client = _RecordingClient()
    solver = _solver(tmp_path, client, grant=_grant(task_id="black-1"))
    out = solver.solve_round(_view())                            # in scope → the one call proceeds
    assert client.sent == 1                                       # exactly one messages.create
    assert out is not None
