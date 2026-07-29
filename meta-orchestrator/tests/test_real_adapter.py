"""Real Anthropic adapter — request building + response parsing, verified offline
via an injected fake client (no network, no API key)."""
from __future__ import annotations

import types

from meta_orchestrator.bootstrap import boot
from meta_orchestrator.config import load_config
from meta_orchestrator.gateway.adapters import (
    AnthropicAdapter,
    build_code_fix_prompt,
    extract_code,
    make_adapter,
)
from meta_orchestrator.gateway.gateway import ModelGateway
from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.seed_task.corpus import get_case
from meta_orchestrator.verification import verify_code_fix


class _FakeMessages:
    def __init__(self, reply_text: str) -> None:
        self._reply = reply_text
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        block = types.SimpleNamespace(type="text", text=self._reply)
        usage = types.SimpleNamespace(input_tokens=120, output_tokens=60)
        return types.SimpleNamespace(content=[block], usage=usage)


class _FakeClient:
    def __init__(self, reply_text: str) -> None:
        self.messages = _FakeMessages(reply_text)


def _fenced(code: str) -> str:
    return f"Here is the fix:\n```python\n{code}```\n"


def test_extract_code_handles_fenced_and_plain():
    assert extract_code("```python\nx = 1\n```").strip() == "x = 1"
    assert extract_code("```\ny = 2\n```").strip() == "y = 2"
    assert extract_code("z = 3").strip() == "z = 3"


def test_prompt_includes_module_and_tests():
    case = get_case("off_by_one_sum")
    prompt = build_code_fix_prompt(case)
    assert case.module_source.strip() in prompt
    assert "def test_sum_to_five" in prompt
    assert case.module_filename in prompt


def test_adapter_parses_reply_and_reports_usage():
    case = get_case("off_by_one_sum")
    client = _FakeClient(_fenced(case.reference_fix))
    adapter = AnthropicAdapter(client=client)
    resp = adapter.complete("claude-opus-4-8", {"kind": "code_fix", "case": case})
    assert resp.content["candidate_source"].strip() == case.reference_fix.strip()
    assert resp.tokens_in == 120 and resp.tokens_out == 60
    # request was shaped per the claude-api guidance (adaptive thinking, no sampling params)
    sent = client.messages.calls[0]
    assert sent["model"] == "claude-opus-4-8"
    assert sent["thinking"] == {"type": "adaptive"}
    assert sent["output_config"] == {"effort": "high"}
    assert "temperature" not in sent and "top_p" not in sent


def test_adapter_uses_extended_thinking_for_haiku():
    # Haiku 4.5 rejects adaptive thinking + effort (400); it must get extended thinking
    # with an explicit budget_tokens (< max_tokens) and no effort param.
    case = get_case("off_by_one_sum")
    client = _FakeClient(_fenced(case.reference_fix))
    adapter = AnthropicAdapter(client=client, max_tokens=16000)
    adapter.complete("claude-haiku-4-5", {"kind": "code_fix", "case": case})
    sent = client.messages.calls[0]
    assert sent["thinking"] == {"type": "enabled", "budget_tokens": 4000}
    assert sent["thinking"]["budget_tokens"] < sent["max_tokens"]
    assert "output_config" not in sent  # effort is unsupported on Haiku 4.5


def test_synthesize_is_passthrough_without_api_call():
    client = _FakeClient("should not be called")
    adapter = AnthropicAdapter(client=client)
    resp = adapter.complete("claude-opus-4-8", {"kind": "synthesize", "candidate_source": "x = 1\n"})
    assert resp.content["artifact"] == "x = 1\n"
    assert client.messages.calls == []  # synthesis makes no model call


def test_make_adapter_injects_client():
    adapter = make_adapter("anthropic", client=_FakeClient("hi"))
    assert isinstance(adapter, AnthropicAdapter)


def test_real_adapter_reply_passes_real_verifier():
    # The real verifier runs pytest against whatever the (faked) model returned.
    case = get_case("wrong_operator_even")
    gw = ModelGateway(_registry_anthropic(), AnthropicAdapter(client=_FakeClient(_fenced(case.reference_fix))))
    result = gw.run("claude-opus-4-8", {"kind": "code_fix", "case": case})
    assert result.cost > 0  # priced from the real-model Registry entry
    assert verify_code_fix(case, result.response.content["candidate_source"]).passed is True


def test_orchestrator_runs_with_injected_real_adapter():
    store, registry, config = boot(load_config(db_path=":memory:", adapter="anthropic"))
    try:
        case = get_case("wrong_return_max")
        orch = Orchestrator(store, registry, config,
                            adapter=AnthropicAdapter(client=_FakeClient(_fenced(case.reference_fix))))
        out = orch.run(case, run_id="real-1")
        assert out.passed is True
        assert out.selected_model in ("claude-opus-4-8", "claude-haiku-4-5")
    finally:
        store.close()


def _registry_anthropic():
    store, registry, _config = boot(load_config(db_path=":memory:", adapter="anthropic"))
    return registry
