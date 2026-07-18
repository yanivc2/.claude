"""The FROZEN §2 agent contract (Decision A) as executable, offline-testable objects.

This module turns ``corpus/S2_AGENT_CONTRACT.md`` (Decision A, frozen 2026-07-16) into a
single source of truth that a test can assert against WITHOUT ever calling a paid API:

  * ``frozen_s2_contract()`` — the exact ``AgentContract`` for ``claude-haiku-4-5-20251001``.
  * ``anthropic_request_kwargs()`` — the PURE payload that WOULD be sent to
    ``client.messages.create(**kwargs)``. It is built here, inspected by tests, and never sent.
  * ``s2_run_policy()`` — the run-time policy (no silent fallback).

Why a §2-specific builder instead of ``gateway/adapters.thinking_kwargs``: the generic helper
derives ``budget_tokens = min(4000, max_tokens // 2)`` (= 2048 at max_tokens 4096). The frozen
contract pins the **1024 floor** and sends **no** ``effort`` (which errors on Haiku 4.5). Routing
§2 through the generic helper would silently violate the frozen contract, so §2 owns its builder
and a test guards the exact shape. Verified against the claude-api catalog (2026-07-16):
Haiku 4.5 uses ``thinking:{type:"enabled", budget_tokens:N}`` (adaptive → 400), ``output_config.
effort`` errors, and temperature/top_p/top_k are omitted with thinking on.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict

from ..contract import AgentContract, prompt_hash

# --- frozen Decision-A constants (mirror corpus/S2_AGENT_CONTRACT.md; do NOT drift) ---
S2_EXACT_MODEL_ID = "claude-haiku-4-5-20251001"     # exact snapshot, never an alias
S2_MAX_TOKENS = 4096                                # per model call
S2_THINKING_BUDGET_TOKENS = 1024                    # the Haiku-4.5 floor, < max_tokens
S2_THINKING = {"type": "enabled", "budget_tokens": S2_THINKING_BUDGET_TOKENS}
S2_AGENT_VERSION = "s2-attempt-v1"
# The frozen system prompt is hashed into the contract snapshot so a silent prompt edit is
# detectable. The prompt TEXT is not needed to prove the request shape; its hash pins it.
S2_SYSTEM_PROMPT = (
    "You are a careful bug-fixing agent. You are given a task statement, the target source "
    "file(s), an optional memory slot, and a fixed tool set. Repair the source so the public "
    "suite passes. Modify only the given source file(s); never edit tests or evaluation logic."
)


class RunPolicy(BaseModel):
    """Run-time execution policy (Decision A): the no-silent-fallback lock, made explicit."""

    model_config = ConfigDict(frozen=True)

    experiment_mode: bool = True
    fallback: str = "off"           # a silent fallback would be an undetectable confound
    sends_effort: bool = False      # output_config.effort ERRORS on Haiku 4.5 — never sent
    sends_temperature: bool = False  # omitted with extended thinking on


def frozen_s2_contract() -> AgentContract:
    """The exact frozen §2 agent contract for the micro-pilot (identical across A/C/D/B1)."""
    return AgentContract(
        provider="anthropic",
        exact_model_id=S2_EXACT_MODEL_ID,
        agent_version=S2_AGENT_VERSION,
        api_config={"max_tokens": S2_MAX_TOKENS},
        # `thinking` lives verbatim here; NOTE the deliberate ABSENCE of any `effort` key.
        reasoning_settings={"thinking": dict(S2_THINKING)},
        temperature=None,                       # not sent (incompatible with extended thinking)
        tool_definitions=["read_source", "read_public_tests", "write_source", "run_public_tests"],
        system_prompt_hash=prompt_hash(S2_SYSTEM_PROMPT),
    )


def s2_run_policy() -> RunPolicy:
    return RunPolicy()


def anthropic_request_kwargs(
    contract: AgentContract, *, prompt: str, system: Optional[str] = None
) -> dict[str, Any]:
    """Build the EXACT kwargs that would go to ``client.messages.create`` — and never send them.

    This is the honest, $0 way to prove the adapter is faithful to the frozen contract: the test
    inspects this dict. It intentionally never emits ``output_config``/``effort``,
    ``temperature``, ``top_p`` or ``top_k`` — Decision A omits all of them on Haiku 4.5.
    """
    kwargs: dict[str, Any] = {
        "model": contract.exact_model_id,
        "max_tokens": contract.api_config["max_tokens"],
        "messages": [{"role": "user", "content": prompt}],
    }
    if system is not None:
        kwargs["system"] = system
    # thinking is copied verbatim from the frozen contract; no effort is ever synthesised.
    thinking = contract.reasoning_settings.get("thinking")
    if thinking is not None:
        kwargs["thinking"] = dict(thinking)
    # temperature ONLY if the contract explicitly pins one (it does not, for §2).
    if contract.temperature is not None:
        kwargs["temperature"] = contract.temperature
    return kwargs


def _deep_key_present(obj: Any, key: str) -> bool:
    """True if ``key`` appears anywhere in a nested dict/list — used by the contract test."""
    if isinstance(obj, dict):
        if key in obj:
            return True
        return any(_deep_key_present(v, key) for v in obj.values())
    if isinstance(obj, (list, tuple)):
        return any(_deep_key_present(v, key) for v in obj)
    return False
