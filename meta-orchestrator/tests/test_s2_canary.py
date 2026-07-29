"""Live canary path proven END-TO-END with a fake httpx transport — $0, no real messages.create.

Covers: R1/R2 single-source byte-parity with the counter; the strict parser; the two mandatory
scenarios (R1 terminal success; R1 public FAIL → R2); a parse-failure that is a SOLVER failure (not
infra); the journal state machine incl. AMBIGUOUS_AFTER_SEND holding the reservation; prepared==sent
at the HTTP boundary; and isolation (all state under tmp; no official artifact touched).

Everything here is NON_AUTHORITATIVE_FAKE_TRANSPORT: synthetic responses, synthetic usage.
"""
from __future__ import annotations

import json

import httpx
import pytest

from meta_orchestrator.experiment.s2 import (RESPONSE_SCHEMA, LESSON_SCHEMA, REPAIR_INSTRUCTION,
                                             build_r1_worstcase_prompt, build_r2_messages,
                                             parse_model_response, run_canary, NON_AUTHORITATIVE_TAG,
                                             load_frozen_pricing, resolve_endpoint_attestation,
                                             ModelBackedRoundSolver, BudgetLedger, CallJournal,
                                             CALL_AMBIGUOUS_AFTER_SEND, assert_frozen_pieces_match,
                                             GateError)
from meta_orchestrator.experiment.s2.canary_prompt import frozen_pieces_snapshot
from meta_orchestrator.experiment.s2.memory import SLOT_MAX_CHARS, SLOT_MAX_LINES
from meta_orchestrator.experiment.s2.prompt import MEMORY_OPEN, MEMORY_CLOSE
from meta_orchestrator.experiment.s2.model_client import S2ModelClient
from meta_orchestrator.experiment.s2.synthetic import synthetic_task
from meta_orchestrator.experiment.s2.contract_s2 import frozen_s2_contract


CORPUS = "corpus"


def _sr(search, replace, *, path="solution.py"):
    """Build a frozen SEARCH/REPLACE ### PATCH ... ### END body for one file/block."""
    return (f"### PATCH\n### FILE: {path}\n<<<<<<< SEARCH\n{search}\n=======\n{replace}\n"
            ">>>>>>> REPLACE\n### END")


def _lesson_block():
    return ('### LESSON\n{"recommended_action": ["prefer a minimal targeted edit"], '
            '"avoid": ["sweeping rewrites"]}\n')


# --- 1. single-source byte parity with the frozen counter -------------------------------
def _counter_r1(statement, source, train):
    line = "- " + ("m" * (SLOT_MAX_CHARS - 2))
    mem = "\n".join([MEMORY_OPEN, *[line for _ in range(SLOT_MAX_LINES)], MEMORY_CLOSE])
    parts = ["# Bug report", statement, "", "# Target source files (edit ONLY these)"]
    for path in sorted(source):
        parts.append(f"## {path}\n```python\n{source[path]}\n```")
    parts += ["", mem, "", (LESSON_SCHEMA if train else "") + RESPONSE_SCHEMA]   # LESSON-first
    return "\n".join(parts)


def test_r1_worstcase_byte_parity_with_counter():
    stmt, src = "A bug.", {"src/b.py": "def f():\n    return 1\n", "src/a.py": "x=1\n"}
    for train in (True, False):
        assert build_r1_worstcase_prompt(stmt, src, train=train) == _counter_r1(stmt, src, train)


def test_frozen_pieces_guard_blocks_drift():
    good = frozen_pieces_snapshot()                        # includes patch_caps now
    assert_frozen_pieces_match(good)                       # no raise
    bad = dict(good); bad["public_feedback_cap"] = 1500
    with pytest.raises(GateError):
        assert_frozen_pieces_match(bad)
    bad2 = dict(good); bad2["patch_caps"] = dict(good["patch_caps"], max_patch_blocks=999)
    with pytest.raises(GateError):
        assert_frozen_pieces_match(bad2)


# --- 2. strict parser (SEARCH/REPLACE, LESSON-first, mandatory ### END) ------------------
def test_parser_accepts_valid_patch_and_lesson():
    text = _lesson_block() + _sr("def f():\n    return 1", "def f():\n    return 2")
    p = parse_model_response(text, allowed_source_files=["solution.py"],
                             task_family="whitespace", is_train=True)
    assert p.ok and "solution.py" in p.edits and p.candidate_lesson is not None
    assert p.edits["solution.py"] == [("def f():\n    return 1", "def f():\n    return 2")]


def test_parser_rejects_out_of_scope_path():
    text = _lesson_block() + _sr("x=1", "x=2", path="tests_public/test_x.py")
    p = parse_model_response(text, allowed_source_files=["solution.py"], task_family="whitespace",
                             is_train=True)
    assert not p.ok and p.edits == {} and p.reason.startswith("PATCH_PATH_FORBIDDEN")


def test_parser_garbage_is_solver_failure_not_infra():
    p = parse_model_response("I think the bug is subtle. No code.", allowed_source_files=["solution.py"],
                             task_family="whitespace", is_train=True)
    assert not p.ok and p.edits == {} and p.reason == "missing_end"   # no ### END → structural


def test_parser_missing_end_is_truncation_signal():
    text = _lesson_block() + _sr("a", "b").removesuffix("\n### END")   # drop the sentinel
    p = parse_model_response(text, allowed_source_files=["solution.py"], task_family="whitespace",
                             is_train=True)
    assert not p.ok and p.reason == "missing_end" and p.end_marker_present is False


def test_parser_bad_lesson_json_in_train_is_schema_failure():
    text = "### LESSON\n{not json}\n" + _sr("def f():\n    return 1", "def f():\n    return 2")
    p = parse_model_response(text, allowed_source_files=["solution.py"], task_family="whitespace",
                             is_train=True)
    assert not p.ok and p.reason == "malformed_lesson"


def test_parser_empty_search_rejected():
    text = "### PATCH\n### FILE: solution.py\n<<<<<<< SEARCH\n=======\nx=1\n>>>>>>> REPLACE\n### END"
    p = parse_model_response(text, allowed_source_files=["solution.py"], task_family="whitespace",
                             is_train=False)
    assert not p.ok and p.reason.startswith("PATCH_SCHEMA_INVALID")


# --- fake httpx transport harness -------------------------------------------------------
class _Scripted:
    """A real anthropic client whose HTTP is a MockTransport returning scripted messages."""

    def __init__(self, responses):
        import anthropic
        self.responses = list(responses)            # [(text, in_tok, out_tok), ...]
        self.sent_bodies = []
        self.idx = 0
        model = frozen_s2_contract().exact_model_id

        def handler(request: httpx.Request) -> httpx.Response:
            self.sent_bodies.append(json.loads(request.content.decode()))
            text, itok, otok = self.responses[self.idx]
            self.idx += 1
            return httpx.Response(200, json={
                "id": "msg_fake", "type": "message", "role": "assistant", "model": model,
                "content": [{"type": "text", "text": text}], "stop_reason": "end_turn",
                "stop_sequence": None, "usage": {"input_tokens": itok, "output_tokens": otok}})

        self.anthropic = anthropic.Anthropic(
            api_key="sk-fake", base_url="https://api.anthropic.com",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)), max_retries=0)


def _fix_resp(task, *, lesson=True):
    # whole-file SEARCH/REPLACE: replace the buggy source with the KNOWN-good fix (one unique block)
    lead = ('### LESSON\n{"recommended_action": ["read the range bound carefully"], '
            '"avoid": ["editing tests"]}\n') if lesson else ""
    return lead + _sr(task.source["solution.py"], task.reference_fix["solution.py"])


def _bug_resp(task):
    # a no-op SEARCH/REPLACE (replace == search) → applies cleanly but keeps the bug → public FAIL.
    # carries a lesson so it is a schema-valid C-training reply (is_train requires ### LESSON first).
    body = task.source["solution.py"]
    return _lesson_block() + _sr(body, body)


def _grant_for(task, *, fold=1, condition="C"):
    from meta_orchestrator.experiment.s2.execution_grant import build_execution_grant
    return build_execution_grant(grant_id=f"g-{task.task_id}", anchor_commit="HEAD",
                                 anchor_report_hash="rh", fold=fold, condition=condition,
                                 phase="training", task_id=task.task_id, curriculum_hash="cur",
                                 curriculum_position=0, granted_at="2026-07-19T00:00:00Z")


def _canary(tmp_path, responses, *, task, execution_grant="__default__"):
    sc = _Scripted(responses)
    client = S2ModelClient(frozen_s2_contract(), client=sc.anthropic)
    pricing = load_frozen_pricing(CORPUS)
    ep = resolve_endpoint_attestation(provider=pricing.provider, model=pricing.model,
                                      client=sc.anthropic)
    grant = _grant_for(task) if execution_grant == "__default__" else execution_grant
    rep = run_canary(task, client=client, statement="Fix the off-by-one.", pricing=pricing,
                     endpoint_att=ep, work_dir=str(tmp_path / "canary"),
                     count_fn=lambda kw: len(json.dumps(kw)) // 4, env_hash="e",
                     non_authoritative=True, execution_grant=grant)
    return rep, sc, client


# --- 3. Scenario 1: R1 terminal success -------------------------------------------------
def test_scenario1_r1_success(tmp_path):
    task = synthetic_task("black-canary", "whitespace")
    rep, sc, client = _canary(tmp_path, [(_fix_resp(task), 9000, 120)], task=task)
    assert rep["tag"] == NON_AUTHORITATIVE_TAG
    assert rep["attempt"]["round1_public_status"] == "PASS"
    assert rep["attempt"]["model_calls"] == 1 and not rep["attempt"]["round2_opened"]
    assert rep["attempt"]["passed"] is True
    assert rep["attempt"]["f2p_feedback_leaked"] is False
    assert rep["all_calls_complete"] is True
    assert rep["write_gate"]["written"] == 1                       # verifier PASS + clean lesson
    assert rep["write_gate"]["bank_after"] != rep["write_gate"]["bank_before"]
    assert rep["reforecast"]["fits_after_canary"] is True
    # prepared == sent at the HTTP boundary
    assert json.loads(client.last_request_json)["messages"] == sc.sent_bodies[-1]["messages"]


# --- 4. Scenario 2: R1 public FAIL → R2 -------------------------------------------------
def test_scenario2_r1_fail_then_r2(tmp_path):
    task = synthetic_task("black-canary", "whitespace")
    responses = [(_bug_resp(task), 9000, 100),          # R1 still buggy → public FAIL
                 (_fix_resp(task), 12000, 110)]          # R2 fixes → PASS
    rep, sc, _ = _canary(tmp_path, responses, task=task)
    assert rep["attempt"]["round1_public_status"] == "FAIL"
    assert rep["attempt"]["round2_opened"] is True
    assert rep["attempt"]["model_calls"] == 2
    assert rep["attempt"]["passed"] is True
    assert len(sc.sent_bodies) == 2
    assert len(sc.sent_bodies[0]["messages"]) == 1 and len(sc.sent_bodies[1]["messages"]) == 3
    # R2 carried the sanitized public feedback + repair instruction
    assert sc.sent_bodies[1]["messages"][2]["content"].endswith(REPAIR_INSTRUCTION)
    assert rep["all_calls_complete"] is True


# --- 5. parse failure is a solver failure (no crash, no infra) ---------------------------
def test_scenario3_parse_failure_is_solver_fail(tmp_path):
    task = synthetic_task("black-canary", "whitespace")
    # unparseable R1 → empty patch → public FAIL → repair round → unparseable R2 → solver failure.
    rep, _, _ = _canary(tmp_path, [("no code at all, just musing", 8000, 30),
                                   ("still no code, sorry", 8200, 25)], task=task)
    assert rep["attempt"]["passed"] is False
    assert rep["attempt"]["patches_applied"] == 0
    assert rep["attempt"]["model_calls"] == 2                      # genuine public FAIL bought R2
    assert rep["all_calls_complete"] is True                       # the calls themselves completed
    assert rep["write_gate"]["written"] == 0


# --- 6. AMBIGUOUS_AFTER_SEND holds the reservation --------------------------------------
def test_ambiguous_after_send_holds_reservation(tmp_path):
    class _Boom:
        def build_request_messages(self, messages):
            return {"model": "m", "system": "s", "messages": messages, "thinking": {}, "max_tokens": 4096}
        def complete_messages(self, messages):
            raise RuntimeError("connection reset")
        last_request_json = "{}"
    pricing = load_frozen_pricing(CORPUS)
    ep = resolve_endpoint_attestation(provider=pricing.provider, model=pricing.model,
                                      env={"ANTHROPIC_BASE_URL": "https://api.anthropic.com"})
    ledger = BudgetLedger(str(tmp_path / "l.json"), total_budget=10.0)
    journal = CallJournal(str(tmp_path / "j.jsonl"))
    from meta_orchestrator.experiment.s2.solver import RoundView
    from meta_orchestrator.experiment.s2.execution_grant import (GrantUsageLedger,
                                                                 build_execution_grant)
    grant = build_execution_grant(grant_id="g-t", anchor_commit="HEAD", anchor_report_hash="rh",
                                  fold=1, condition="C", phase="training", task_id="t",
                                  curriculum_hash="cur", curriculum_position=0,
                                  granted_at="2026-07-19T00:00:00Z")
    gled = GrantUsageLedger(str(tmp_path / "gl.json"))
    solver = ModelBackedRoundSolver(client=_Boom(), statement="s", allowed_source_files=["solution.py"],
                                    task_family="whitespace", is_train=True, pricing=pricing,
                                    endpoint_att=ep, ledger=ledger, journal=journal, fold=1,
                                    condition="C", context_cap=60416, count_fn=lambda kw: 100,
                                    run_id="amb", env_hash="e", contract_hash="k", active_bank_hash="b",
                                    task_id="t", execution_grant=grant, grant_ledger=gled)
    view = RoundView(round_index=1, task_id="t", task_family="whitespace",
                     source={"solution.py": "x=1"}, public_tests={}, memory_lines=[])
    before = ledger.available()
    with pytest.raises(RuntimeError):
        solver.solve_round(view)
    call_id = "amb:f1:C:r1"
    assert CALL_AMBIGUOUS_AFTER_SEND in journal.states_for(call_id)
    assert ledger.available() < before                             # reservation NOT released


# --- 7. isolation: nothing outside work_dir is written ----------------------------------
def test_isolation_only_workdir_touched(tmp_path):
    import os
    task = synthetic_task("black-canary", "whitespace")
    rep, _, _ = _canary(tmp_path, [(_fix_resp(task), 9000, 50)], task=task)
    files = set(os.listdir(tmp_path / "canary"))
    assert files <= {"ledger.json", "journal.jsonl", "grant_ledger.json"}   # isolated ledgers + journal
    assert rep["tag"] == NON_AUTHORITATIVE_TAG
