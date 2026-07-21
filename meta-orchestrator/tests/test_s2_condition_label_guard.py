"""No-condition-label guard for the paid path (apparatus safety net).

The memory slot is the ONLY thing that varies across A/C/D/B1, so the model must never read WHICH
condition it is in. ``render_lines`` emits an ``@@MEM kind=… family=…`` header (a test/debug/audit
affordance); ``prompt.render_memory_payload`` emits only the label-free bullets a real model may see.
These tests freeze that contract: the guard is NARROW + deterministic (only the exact frozen
sentinels), it fires on BOTH R1 and R2 of the live paid solver BEFORE any send, and it never trips
on ordinary task prose. They also prove C and B1 share identical framing and differ only in content.
"""
from __future__ import annotations

import json
import os

import pytest

from meta_orchestrator.experiment.lesson import Lesson
from meta_orchestrator.experiment.s2.canary_prompt import build_r1_user_prompt, build_r2_messages
from meta_orchestrator.experiment.s2.memory import (CONDITION_LABEL_SENTINELS, ConditionLabelLeak,
                                                   FrozenLessonBank, PlaceboRouter, StaticPlaybook,
                                                   assert_no_condition_label,
                                                   find_condition_label_leak, render_lines,
                                                   resolve_memory)
from meta_orchestrator.experiment.s2.prompt import (mask_memory_region, prompt_carries_condition_label,
                                                   render_memory_payload)

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")


def _lesson(fam, lid, rec, avoid):
    return Lesson(lesson_id=lid, task_family=fam, recommended_action=[rec], avoid=[avoid])


def _bank():
    # C family = other_logic; the deranged (B1) family for other_logic is whitespace. Distinct content
    # per family (as in the real bank) so a C vs B1 request differs ONLY in the memory bullets.
    return FrozenLessonBank(by_family={
        "other_logic": [_lesson("other_logic", "L-o", "use the full path, not just the basename",
                                "assuming the filename alone identifies the file")],
        "whitespace": [_lesson("whitespace", "L-w", "remove stray debug prints from token loops",
                               "leaving logging.debug in performance-critical paths")],
    }, frozen=True)


# --- 1. the guard is narrow + deterministic (frozen sentinels only) --------------------------------
def test_sentinels_are_the_frozen_machine_forms_only():
    assert CONDITION_LABEL_SENTINELS == ("@@MEM", "kind=family_relevant", "kind=other_family",
                                         "kind=static_playbook")


def test_render_lines_tagged_payload_is_blocked():
    mc = resolve_memory("C", "other_logic", bank=_bank())
    tagged = render_lines(mc)
    assert find_condition_label_leak("\n".join(tagged)) == "@@MEM"
    with pytest.raises(ConditionLabelLeak):
        assert_no_condition_label(*tagged, where="R1 memory payload")


def test_render_memory_payload_label_free_is_accepted():
    mc = resolve_memory("C", "other_logic", bank=_bank())
    payload = render_memory_payload(mc)
    assert find_condition_label_leak("\n".join(payload)) is None
    assert_no_condition_label(*payload, where="R1 memory payload")     # does not raise


# --- 2. each condition's LABEL-FREE payload carries no condition/family-source/placebo label --------
def test_C_payload_has_no_condition_or_family_label():
    p = render_memory_payload(resolve_memory("C", "other_logic", bank=_bank()))
    assert not prompt_carries_condition_label("\n".join(p))
    assert_no_condition_label(*p, where="C")


def test_B1_payload_has_no_placebo_or_deranged_family_label():
    p = render_memory_payload(resolve_memory("B1", "other_logic", bank=_bank(),
                                             placebo=PlaceboRouter.build()))
    assert not prompt_carries_condition_label("\n".join(p))
    assert_no_condition_label(*p, where="B1")


def test_D_payload_has_no_static_playbook_label():
    pb = StaticPlaybook(by_family={"other_logic": ["prefer explicit over implicit conversions"]},
                        author_frozen=True, author="reviewer")
    p = render_memory_payload(resolve_memory("D", "other_logic", playbook=pb))
    assert not prompt_carries_condition_label("\n".join(p))
    assert_no_condition_label(*p, where="D")


# --- 3. ordinary task prose with generic words is NOT blocked --------------------------------------
def test_ordinary_prose_with_generic_words_is_not_blocked():
    prose = ("The parser family is relevant here; other modules read from memory and set "
             "font-family. None of this is a condition label.")
    assert find_condition_label_leak(prose) is None
    assert_no_condition_label(prose, where="task statement")           # does not raise


# --- 4. R2 assembled from a tagged R1 history is blocked -------------------------------------------
def test_r2_assembled_with_tagged_history_is_blocked():
    # The model echoed a tag into its R1 output; the R2 request would then carry it back as input.
    tagged_assistant = "### PATCH\n@@MEM kind=family_relevant family=other_logic\n### END"
    msgs = build_r2_messages("clean R1 user prompt", tagged_assistant, "public feedback")
    with pytest.raises(ConditionLabelLeak):
        assert_no_condition_label(*[m["content"] for m in msgs], where="R2 request")


# --- 5. a label-free prepared body but a tagged SERIALIZED sent body is blocked --------------------
def test_serialized_sent_body_tagged_is_blocked_even_if_intent_was_clean():
    serialized = json.dumps({"model": "m", "system": "s",
                             "messages": [{"role": "user",
                                           "content": "…<memory>\n@@MEM kind=other_family family=whitespace\n"
                                                      "- advice\n</memory>…"}]}, sort_keys=True)
    assert find_condition_label_leak(serialized) == "@@MEM"
    with pytest.raises(ConditionLabelLeak):
        assert_no_condition_label(serialized, where="serialized outbound body")


# --- 6. C and B1 share identical framing and differ ONLY in lesson content -------------------------
def test_C_and_B1_have_identical_framing_and_differ_only_in_memory_content():
    bank = _bank()
    src = {"solution.py": "def f():\n    return 1\n"}
    stmt = "Repair the bug."
    c_payload = render_memory_payload(resolve_memory("C", "other_logic", bank=bank))
    b1_payload = render_memory_payload(resolve_memory("B1", "other_logic", bank=bank,
                                                      placebo=PlaceboRouter.build()))
    pc = build_r1_user_prompt(stmt, src, c_payload, train=True)
    pb1 = build_r1_user_prompt(stmt, src, b1_payload, train=True)
    # neither request carries a condition label …
    assert not prompt_carries_condition_label(pc) and not prompt_carries_condition_label(pb1)
    assert_no_condition_label(pc, where="C R1")
    assert_no_condition_label(pb1, where="B1 R1")
    # … and once the memory region is masked they are byte-identical (framing is the same).
    assert mask_memory_region(pc) == mask_memory_region(pb1)
    # the ONLY difference is the memory content (C's other_logic lesson vs B1's whitespace lesson).
    assert pc != pb1


# --- 7. the guard is wired into the LIVE paid solver for BOTH rounds (no send on a leak) -----------
class _RecordingClient:
    """Fake client that records whether a send (complete_messages) ever happened."""
    def __init__(self):
        self.sent = 0
        self.last_request_json = "{}"

    def build_request_messages(self, messages):
        return {"model": "m", "system": "s", "messages": messages, "thinking": {}, "max_tokens": 4096}

    def complete_messages(self, messages):          # a send — must NEVER be reached on a leak
        self.sent += 1
        raise AssertionError("send happened despite a condition-label leak")


def _solver(client, tmp_path):
    from meta_orchestrator.experiment.s2.call_journal import BudgetLedger, CallJournal
    from meta_orchestrator.experiment.s2.execution_grant import (GrantUsageLedger,
                                                                build_execution_grant)
    from meta_orchestrator.experiment.s2.endpoint import resolve_endpoint_attestation
    from meta_orchestrator.experiment.s2.live_solver import ModelBackedRoundSolver
    from meta_orchestrator.experiment.s2.pricing import load_frozen_pricing
    pricing = load_frozen_pricing(_CORPUS)
    ep = resolve_endpoint_attestation(provider=pricing.provider, model=pricing.model,
                                      env={"ANTHROPIC_BASE_URL": "https://api.anthropic.com"})
    grant = build_execution_grant(grant_id="g-t", anchor_commit="HEAD", anchor_report_hash="rh",
                                  fold=1, condition="C", phase="training", task_id="t",
                                  curriculum_hash="cur", curriculum_position=0,
                                  granted_at="2026-07-19T00:00:00Z")
    return ModelBackedRoundSolver(
        client=client, statement="s", allowed_source_files=["solution.py"], task_family="other_logic",
        is_train=True, pricing=pricing, endpoint_att=ep,
        ledger=BudgetLedger(str(tmp_path / "l.json"), total_budget=10.0),
        journal=CallJournal(str(tmp_path / "j.jsonl")), fold=1, condition="C", context_cap=60416,
        count_fn=lambda kw: 100, run_id="lbl", env_hash="e", contract_hash="k", active_bank_hash="b",
        task_id="t", execution_grant=grant, grant_ledger=GrantUsageLedger(str(tmp_path / "gl.json")))


def test_live_solver_blocks_tagged_R1_before_any_send(tmp_path):
    from meta_orchestrator.experiment.s2.solver import RoundView
    client = _RecordingClient()
    solver = _solver(client, tmp_path)
    tagged = render_lines(resolve_memory("C", "other_logic", bank=_bank()))   # the exact latent bug
    view = RoundView(round_index=1, task_id="t", task_family="other_logic",
                     source={"solution.py": "x=1"}, public_tests={}, memory_lines=tagged)
    with pytest.raises(ConditionLabelLeak):
        solver.solve_round(view)
    assert client.sent == 0                                                    # never sent


def test_live_solver_blocks_tagged_R2_before_any_send(tmp_path):
    from meta_orchestrator.experiment.s2.solver import RoundView
    client = _RecordingClient()
    solver = _solver(client, tmp_path)
    # simulate a completed R1 whose assistant text carried a tag back into the R2 history
    solver._r1_prompt = "clean R1 user prompt"
    solver._assistant_text = "### PATCH\n@@MEM kind=family_relevant family=other_logic\n### END"
    view = RoundView(round_index=2, task_id="t", task_family="other_logic",
                     source={"solution.py": "x=1"}, public_tests={}, memory_lines=[],
                     public_feedback="tests failed")
    with pytest.raises(ConditionLabelLeak):
        solver.solve_round(view)
    assert client.sent == 0                                                    # never sent


def test_live_solver_accepts_label_free_R1_payload(tmp_path):
    # a label-free payload passes the guard; the send then fails for an UNRELATED reason (the fake
    # client raises inside complete_messages), proving the guard did NOT block a clean request.
    from meta_orchestrator.experiment.s2.solver import RoundView
    client = _RecordingClient()
    solver = _solver(client, tmp_path)
    payload = render_memory_payload(resolve_memory("C", "other_logic", bank=_bank()))
    view = RoundView(round_index=1, task_id="t", task_family="other_logic",
                     source={"solution.py": "x=1"}, public_tests={}, memory_lines=payload)
    with pytest.raises(AssertionError, match="send happened"):                 # got past the guard to the send
        solver.solve_round(view)
    assert client.sent == 1
