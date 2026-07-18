"""Pre-paid freeze tests (GPT review batch): whole-request parity, no-label prompt,
counterbalancing, infra policy, response-parser robustness, cross-fold canary, and a
(skipped-here) SDK-serialized-body interception for the pilot environment.

All offline and model-free.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.s2 import (RETRY_POLICY, build_agent_prompt,
                                             classify_attempt_outcome, condition_order,
                                             frozen_s2_contract, mask_memory_region,
                                             prompt_carries_condition_label, render_memory_payload,
                                             resolve_memory, train_order)
from meta_orchestrator.experiment.s2.memory import FrozenLessonBank, PlaceboRouter, StaticPlaybook
from meta_orchestrator.experiment.lesson import Lesson, LessonTrigger
from meta_orchestrator.experiment.s2.model_client import S2ModelClient, _parse_message


def _bank():
    ls = [Lesson(lesson_id="L-w", task_family="whitespace",
                 trigger=LessonTrigger(symptoms=["s"]), recommended_action=["minimal edit"],
                 status="active"),
          Lesson(lesson_id="L-i", task_family="iterator",
                 trigger=LessonTrigger(symptoms=["s"]), recommended_action=["advance once"],
                 status="active")]
    return FrozenLessonBank(by_family={"whitespace": [ls[0]], "iterator": [ls[1]]}, frozen=True)


def _playbook():
    return StaticPlaybook(by_family={"whitespace": ["prefer a minimal edit"]},
                          author_frozen=True, author="independent")


# --- P0.3/D: whole-request parity across conditions, no condition label -------------------
def _prompt_for(condition, bank, placebo, playbook):
    mc = resolve_memory(condition, "whitespace", bank=bank, playbook=playbook, placebo=placebo)
    return build_agent_prompt(source={"solution.py": "def f():\n    return 1\n"},
                              public_tests={"tests_public/test_p.py": "def test():\n    assert True\n"},
                              memory_payload=render_memory_payload(mc))


def test_held_out_requests_are_byte_identical_except_memory():
    bank, placebo, pb = _bank(), PlaceboRouter.build(["whitespace", "iterator"]), _playbook()
    prompts = {c: _prompt_for(c, bank, placebo, pb) for c in ("A", "C", "D", "B1")}
    masked = {c: mask_memory_region(p) for c, p in prompts.items()}
    # everything outside the memory region is identical across all four conditions
    assert len(set(masked.values())) == 1
    # and the conditions genuinely differ INSIDE the region (except A which is empty)
    assert prompts["C"] != prompts["A"]


def test_prompt_carries_no_condition_or_family_label():
    bank, placebo, pb = _bank(), PlaceboRouter.build(["whitespace", "iterator"]), _playbook()
    for c in ("A", "C", "D", "B1"):
        p = _prompt_for(c, bank, placebo, pb)
        assert not prompt_carries_condition_label(p)   # no @@MEM/kind=/placebo/family_relevant


def test_whole_request_parity_through_model_client():
    bank, placebo, pb = _bank(), PlaceboRouter.build(["whitespace", "iterator"]), _playbook()
    reqs = {}
    for c in ("A", "C", "D", "B1"):
        client = S2ModelClient(frozen_s2_contract(), client=_Recorder())
        client.complete(_prompt_for(c, bank, placebo, pb))
        body = dict(client.last_request_kwargs)
        body["messages"] = [{"role": m["role"], "content": mask_memory_region(m["content"])}
                            for m in body["messages"]]
        reqs[c] = body
    import json
    assert len({json.dumps(b, sort_keys=True) for b in reqs.values()}) == 1


class _Recorder:
    def __init__(self):
        self.messages = self

    def create(self, **kwargs):
        return type("M", (), {"content": [], "usage": None, "model": "claude-haiku-4-5-20251001"})()


# --- counterbalancing + curriculum order -------------------------------------------------
def test_condition_order_is_deterministic_and_a_permutation():
    for tid in ("black-1", "cookiecutter-18", "discord.py-7818"):
        o = condition_order(tid)
        assert sorted(o) == ["A", "B1", "C", "D"]
        assert condition_order(tid) == o          # deterministic


def test_condition_order_is_balanced_across_tasks():
    tasks = [f"t-{i}" for i in range(40)]
    first = [condition_order(t)[0] for t in tasks]
    # each condition leads for at least one task → not a fixed A→C→D→B1 every time
    assert len(set(first)) >= 3


def test_train_order_is_frozen_sorted():
    assert train_order(["b", "a", "c"]) == ["a", "b", "c"]


# --- infra-error policy -------------------------------------------------------------------
def test_infra_error_is_incomplete_not_a_fail():
    o = classify_attempt_outcome("INFRA_ERROR", verdict_passed=False)
    assert o.status == "incomplete" and o.counts_in_paired_analysis is False


def test_no_public_tests_defers_to_hidden_verdict():
    assert classify_attempt_outcome("NO_PUBLIC_TESTS", True).status == "solver_pass"
    assert classify_attempt_outcome("NO_PUBLIC_TESTS", False).status == "solver_fail"


def test_retry_policy_is_condition_blind():
    assert RETRY_POLICY["retry_is_condition_blind"] is True
    assert RETRY_POLICY["on_exhausted"] == "withhold_paired_task"


# --- response-parser robustness -----------------------------------------------------------
def test_parser_handles_response_variants():
    def msg(blocks, model="claude-haiku-4-5-20251001", usage=None):
        return type("M", (), {"content": blocks, "usage": usage, "model": model})()

    def block(t="text", **kw):
        return type("B", (), {"type": t, **kw})()

    # valid text
    assert _parse_message(msg([block(text="ok")]), requested_model="claude-haiku-4-5-20251001").text == "ok"
    # empty content
    assert _parse_message(msg([]), requested_model="claude-haiku-4-5-20251001").text == ""
    # non-text block only (e.g. a tool_use) → empty text, no crash
    assert _parse_message(msg([block(t="tool_use", id="x")]),
                          requested_model="claude-haiku-4-5-20251001").text == ""


# --- cross-fold canary (no persistent state carries a fold-0 marker into fold-1) ----------
def test_prompt_has_no_cross_fold_state():
    # A prompt is built purely from the task + memory payload; there is no hidden history/cache.
    bank = _bank()
    p = build_agent_prompt(source={"solution.py": "x=1\n"}, public_tests={},
                           memory_payload=render_memory_payload(
                               resolve_memory("C", "whitespace", bank=bank)))
    assert "fold0-canary" not in p                # nothing from another fold can appear


# --- SDK-serialized-body interception (runs only where the anthropic SDK is installed) ----
def test_sdk_serialized_body_omits_effort_and_temperature():
    anthropic = pytest.importorskip("anthropic")   # skipped offline; MUST run in the pilot env
    httpx = pytest.importorskip("httpx")
    captured = {}

    def handler(request):
        captured["body"] = request.content.decode("utf-8")
        return httpx.Response(200, json={"id": "m", "type": "message", "role": "assistant",
                                         "model": "claude-haiku-4-5-20251001",
                                         "content": [{"type": "text", "text": "ok"}],
                                         "stop_reason": "end_turn",
                                         "usage": {"input_tokens": 1, "output_tokens": 1}})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = anthropic.Anthropic(api_key="test", http_client=http_client)
    S2ModelClient(frozen_s2_contract(), client=client).complete("fix it")
    body = captured["body"]
    for banned in ('"effort"', '"temperature"', '"top_p"', '"top_k"', "output_config"):
        assert banned not in body
    assert '"budget_tokens":1024' in body.replace(" ", "")
