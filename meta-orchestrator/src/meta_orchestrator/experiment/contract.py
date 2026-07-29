"""Frozen agent contract (v2 §5).

Everything that could confound a comparison is pinned and hashed per run: provider,
EXACT model id (e.g. ``claude-haiku-4-5-20251001`` — never a moving alias), API/reasoning
settings, tool definitions, system-prompt hash, agent version. The snapshot hash goes
into the RUN_CREATED event so a run is exactly reproducible and auditable.
"""
from __future__ import annotations

import hashlib
import json

from pydantic import BaseModel, ConfigDict, Field


class AgentContract(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    provider: str                          # "mock" | "anthropic"
    exact_model_id: str                    # pinned snapshot id, not an alias
    agent_version: str
    api_config: dict = Field(default_factory=dict)        # e.g. {"max_tokens": 16000}
    reasoning_settings: dict = Field(default_factory=dict)  # e.g. {"effort": "high"}
    temperature: float | None = None       # None on Opus 4.8 (sampling params removed)
    tool_definitions: list[str] = Field(default_factory=list)  # names of the fixed tool contract
    system_prompt_hash: str = ""

    def snapshot(self) -> str:
        """Deterministic content hash of the frozen configuration."""
        payload = json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()


def prompt_hash(system_prompt: str) -> str:
    return hashlib.sha256(system_prompt.encode()).hexdigest()
