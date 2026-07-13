"""Model adapters (SPEC §9). Agent logic (how a model attempts the task) lives here,
separated from orchestration (SPEC §16.3).

The mock adapter is DETERMINISTIC: each (model, bug-category) either yields the correct
fix or a failing attempt, per a fixed competence profile. This makes verify() produce a
real pass/fail signal and lets the bandit learn which model is better — with no network.
"""
from __future__ import annotations

from typing import Any, Protocol

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

    def complete(self, model_id: str, request: AdapterRequest) -> AdapterResponse: ...


# Which bug categories each mock model can actually fix (fixed competence profile).
_MOCK_COMPETENCE: dict[str, set[str]] = {
    "mock-strong": {"off_by_one", "wrong_operator", "wrong_return"},
    "mock-weak": {"wrong_operator"},
}


class MockAdapter:
    """Deterministic offline adapter for the code-fix seed task."""

    name = "mock"

    def complete(self, model_id: str, request: AdapterRequest) -> AdapterResponse:
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


class AnthropicAdapter:
    """Placeholder real adapter (SPEC §9). Not wired in the offline Phase 1 MVP.

    Kept as an explicit seam: selecting ``model_adapter="anthropic"`` would require an
    API key and network; the mock adapter is the default so tests stay deterministic.
    """

    name = "anthropic"

    def complete(self, model_id: str, request: AdapterRequest) -> AdapterResponse:  # pragma: no cover
        raise NotImplementedError(
            "Real model adapter is not enabled in the offline Phase 1 MVP. "
            "Set META_ORCH_ADAPTER + credentials and implement complete()."
        )


def make_adapter(name: str) -> ModelAdapter:
    if name == "mock":
        return MockAdapter()
    if name == "anthropic":
        return AnthropicAdapter()
    raise ValueError(f"unknown model adapter {name!r}")
