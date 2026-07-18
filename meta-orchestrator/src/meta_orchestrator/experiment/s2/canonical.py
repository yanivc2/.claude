"""One canonical request representation feeding BOTH Messages and count_tokens (P0.1).

The review's largest remaining offline hole: if the Messages path and the count_tokens path each
build their own "equivalent" request, they can silently drift (a tool omitted, a different system
prompt, memory at a different point, thinking dropped) — so count_tokens would freeze a cap for a
request that is NOT the one actually sent. The fix is a single ``CanonicalS2Request`` with two
adapters that differ ONLY in endpoint-specific fields:

  * Messages adapter → includes ``max_tokens`` (the output budget).
  * count_tokens adapter → omits ``max_tokens`` (the counting endpoint does not accept it).

Everything semantic — model, system, messages, tools, thinking — is byte-identical across both.
A differential test asserts that. Request hashing is over the shared (endpoint-independent) core.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

from pydantic import BaseModel, Field

from ..contract import AgentContract
from .contract_s2 import S2_SYSTEM_PROMPT, frozen_s2_contract

# Fields that exist ONLY on the Messages endpoint and are dropped for counting.
_MESSAGES_ONLY = ("max_tokens",)


class CanonicalS2Request(BaseModel):
    """The single source of truth for one model request; both adapters derive from it."""

    model: str
    system: str
    messages: list[dict] = Field(default_factory=list)
    tools: list = Field(default_factory=list)
    thinking: Optional[dict] = None
    max_tokens: int                               # Messages-only (see adapters)

    # --- the shared, endpoint-independent semantic core (what MUST match across adapters) ---
    def shared_core(self) -> dict[str, Any]:
        core = {"model": self.model, "system": self.system, "messages": self.messages,
                "tools": self.tools}
        if self.thinking is not None:
            core["thinking"] = self.thinking
        return core

    def messages_kwargs(self) -> dict[str, Any]:
        kw = dict(self.shared_core())
        kw["max_tokens"] = self.max_tokens
        # never emit tools when empty (keeps parity with the historic request shape)
        if not kw["tools"]:
            kw.pop("tools")
        return kw

    def count_tokens_kwargs(self) -> dict[str, Any]:
        kw = dict(self.shared_core())
        if not kw["tools"]:
            kw.pop("tools")
        # NO max_tokens — the counting endpoint rejects it.
        return kw

    def canonical_hash(self) -> str:
        """Hash of the shared core (endpoint-independent) — the request identity for caching."""
        return hashlib.sha256(
            json.dumps(self.shared_core(), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()


def build_canonical(
    contract: Optional[AgentContract] = None, *, prompt: str, system: Optional[str] = None
) -> CanonicalS2Request:
    """Build the canonical request from the frozen contract + a user prompt (no effort/temp/etc.)."""
    contract = contract or frozen_s2_contract()
    thinking = contract.reasoning_settings.get("thinking")
    return CanonicalS2Request(
        model=contract.exact_model_id,
        system=system if system is not None else S2_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
        tools=[],                                  # this contract sends no API tools
        thinking=dict(thinking) if thinking is not None else None,
        max_tokens=contract.api_config["max_tokens"],
    )


def differential_fields_match(req: CanonicalS2Request) -> bool:
    """True iff the Messages and count_tokens adapters agree on every field except max_tokens."""
    m = req.messages_kwargs()
    c = req.count_tokens_kwargs()
    m_wo = {k: v for k, v in m.items() if k not in _MESSAGES_ONLY}
    return m_wo == c and "max_tokens" in m and "max_tokens" not in c
