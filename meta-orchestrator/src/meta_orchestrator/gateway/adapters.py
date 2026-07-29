"""Model adapters (SPEC §9). Agent logic (how a model attempts the task) lives here,
separated from orchestration (SPEC §16.3).

The mock adapter is DETERMINISTIC: each (model, bug-category) either yields the correct
fix or a failing attempt, per a fixed competence profile. This makes verify() produce a
real pass/fail signal and lets the bandit learn which model is better — with no network.
"""
from __future__ import annotations

import os
from typing import Any, Optional, Protocol

from pydantic import BaseModel, Field

from ..seed_task.definition import BugCase

# A request is a small tagged dict, e.g. {"kind": "code_fix", "case": BugCase}.
AdapterRequest = dict[str, Any]


class AdapterResponse(BaseModel):
    model_config = {"arbitrary_types_allowed": True}

    content: dict[str, Any] = Field(default_factory=dict)
    tokens_in: int = 0
    tokens_out: int = 0


class ModelAdapter(Protocol):
    name: str

    def complete(
        self, model_id: str, request: AdapterRequest, provider_model: Optional[str] = None
    ) -> AdapterResponse: ...


# Which bug categories each mock model can actually fix (fixed competence profile).
_MOCK_COMPETENCE: dict[str, set[str]] = {
    "mock-strong": {"off_by_one", "wrong_operator", "wrong_return"},
    "mock-weak": {"wrong_operator"},
}


class MockAdapter:
    """Deterministic offline adapter for the code-fix seed task."""

    name = "mock"

    def complete(
        self, model_id: str, request: AdapterRequest, provider_model: Optional[str] = None
    ) -> AdapterResponse:
        kind = request.get("kind")
        if kind == "code_fix":
            return self._code_fix(model_id, request["case"])
        if kind == "synthesize":
            # Single-synthesizer step: package the verified candidate coherently.
            src = request["candidate_source"]
            return AdapterResponse(
                content={"artifact": src, "summary": f"Applied fix via {model_id}."},
                tokens_in=len(src) // 4,
                tokens_out=len(src) // 4 + 8,
            )
        raise ValueError(f"MockAdapter: unknown request kind {kind!r}")

    def _code_fix(self, model_id: str, case: BugCase) -> AdapterResponse:
        can_solve = case.category in _MOCK_COMPETENCE.get(model_id, set())
        candidate = case.reference_fix if can_solve else case.module_source  # unchanged = fails
        return AdapterResponse(
            content={"candidate_source": candidate, "solved_intent": can_solve},
            tokens_in=len(case.module_source) // 4 + len(case.test_source) // 4,
            tokens_out=len(candidate) // 4,
        )


# Claude models that support adaptive thinking + the `effort` parameter (Opus 4.6+,
# Sonnet 5 / 4.6, Fable / Mythos 5). Older models (Haiku 4.5, Sonnet 4.5) reject both
# with a 400 ("adaptive thinking is not supported on this model") and must use extended
# thinking with an explicit budget_tokens instead. See the claude-api reference.
_ADAPTIVE_THINKING_MODELS = {
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-fable-5",
    "claude-mythos-5",
}


def thinking_kwargs(model_id: str, max_tokens: int, effort: str) -> dict[str, Any]:
    """Per-model thinking parameters for the Messages API (claude-api guidance).

    Adaptive thinking + `effort` are only accepted on Opus 4.6+, Sonnet 5/4.6, and
    Fable/Mythos 5. Older models (Haiku 4.5) reject them; they take extended thinking
    with an explicit `budget_tokens` (which must be < max_tokens, min 1024) and no
    `effort`. When max_tokens is too small to fit a valid budget, thinking is omitted.
    """
    if model_id in _ADAPTIVE_THINKING_MODELS:
        return {"thinking": {"type": "adaptive"}, "output_config": {"effort": effort}}
    budget = min(4000, max_tokens // 2)
    if budget < 1024:
        return {}
    return {"thinking": {"type": "enabled", "budget_tokens": budget}}


def build_code_fix_prompt(case: BugCase) -> str:
    """Prompt a real model to repair the module so its pytest suite passes."""
    return (
        "You are fixing a bug in a single Python module so its test suite passes.\n\n"
        f"File: {case.module_filename}\n"
        "```python\n"
        f"{case.module_source}"
        "```\n\n"
        "Its pytest suite (do NOT modify the tests):\n"
        "```python\n"
        f"{case.test_source}"
        "```\n\n"
        "Return the COMPLETE corrected contents of "
        f"{case.module_filename} as a single Python code block, and nothing else."
    )


def extract_code(text: str) -> Optional[str]:
    """Pull the module source out of a model reply (fenced block preferred)."""
    fence = "```"
    if fence in text:
        start = text.index(fence) + len(fence)
        # drop an optional language tag on the opening fence line
        nl = text.find("\n", start)
        if nl != -1:
            body_start = nl + 1
            end = text.find(fence, body_start)
            if end != -1:
                return text[body_start:end]
    stripped = text.strip()
    return stripped or None


class AnthropicAdapter:
    """Real adapter (SPEC §9): calls the Claude Messages API via the official SDK.

    The client is dependency-injected so the request-building and response-parsing
    logic is fully testable offline; the default constructs ``anthropic.Anthropic()``,
    which resolves credentials from the environment / ``ant auth login`` profile.
    """

    name = "anthropic"

    def __init__(self, client: Any = None, max_tokens: int = 16000, effort: str = "high") -> None:
        self._client = client
        self._max_tokens = max_tokens
        self._effort = effort

    def _ensure_client(self) -> Any:
        if self._client is None:
            import anthropic  # lazy: keep the SDK optional for the mock path
            # On Claude Code on the web, ANTHROPIC_API_KEY is stripped from the
            # session (requests authenticate via the account), so the dedicated
            # pilot key is supplied under a non-reserved name and pointed at the
            # real API explicitly. Locally, fall back to the SDK's default
            # resolution (ANTHROPIC_API_KEY / `ant auth login`).
            api_key = os.environ.get("META_ORCH_API_KEY")
            if api_key:
                base_url = os.environ.get(
                    "META_ORCH_API_BASE_URL", "https://api.anthropic.com"
                )
                self._client = anthropic.Anthropic(api_key=api_key, base_url=base_url)
            else:
                self._client = anthropic.Anthropic()
        return self._client

    def complete(
        self, model_id: str, request: AdapterRequest, provider_model: Optional[str] = None
    ) -> AdapterResponse:
        # `provider_model` is the exact provider snapshot (e.g. claude-haiku-4-5-20251001);
        # fall back to the logical id when a caller doesn't supply one.
        api_model = provider_model or model_id
        kind = request.get("kind")
        if kind == "synthesize":
            # Deterministic packaging of the already-verified candidate — no extra
            # model call (avoids re-generating and corrupting the verified fix).
            src = request["candidate_source"]
            return AdapterResponse(
                content={"artifact": src, "summary": f"Applied fix via {model_id}."},
                tokens_in=0,
                tokens_out=0,
            )
        if kind != "code_fix":
            raise ValueError(f"AnthropicAdapter: unknown request kind {kind!r}")

        case: BugCase = request["case"]
        client = self._ensure_client()
        # Thinking params are model-aware: adaptive + effort where supported, extended
        # thinking (budget_tokens) on older models like Haiku 4.5 that reject adaptive.
        # Keyed on the provider snapshot so a dated Haiku build still routes to extended.
        msg = client.messages.create(
            model=api_model,
            max_tokens=self._max_tokens,
            messages=[{"role": "user", "content": build_code_fix_prompt(case)}],
            **thinking_kwargs(api_model, self._max_tokens, self._effort),
        )
        text = "".join(
            block.text for block in msg.content if getattr(block, "type", None) == "text"
        )
        candidate = extract_code(text) or case.module_source
        usage = getattr(msg, "usage", None)
        return AdapterResponse(
            content={"candidate_source": candidate},
            tokens_in=getattr(usage, "input_tokens", 0) or 0,
            tokens_out=getattr(usage, "output_tokens", 0) or 0,
        )


def make_adapter(name: str, **kwargs: Any) -> ModelAdapter:
    if name == "mock":
        return MockAdapter()
    if name == "anthropic":
        return AnthropicAdapter(**kwargs)
    raise ValueError(f"unknown model adapter {name!r}")
