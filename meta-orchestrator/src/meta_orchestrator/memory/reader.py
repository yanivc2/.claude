"""Tier-1 playbook read (SPEC §5.1, B5).

The agent reads a compact summary INSTEAD of full history — that is where the token
saving comes from. Returns a tiny dict / one-line string, not an episode log.
"""
from __future__ import annotations

from typing import Any, Optional

from ..persistence.store import Store


class PlaybookReader:
    def __init__(self, store: Store) -> None:
        self._store = store

    def read_tier1(self, key: str) -> Optional[dict[str, Any]]:
        """Compact record for a task type: best model, confidence, rates, avoid list."""
        entry = self._store.get_playbook(key)
        if entry is None:
            return None
        c = entry.content
        return {
            "key": entry.key,
            "best_model": c.get("best_model"),
            "confidence": round(entry.confidence, 3),
            "success_rate_by_model": c.get("success_rate_by_model", {}),
            "avoid": c.get("avoid", []),
            "version": entry.version,
        }

    def render(self, key: str) -> str:
        """One-line, few-token rendering for prompt injection."""
        t = self.read_tier1(key)
        if t is None:
            return f"[playbook:{key}] (none yet)"
        return (
            f"[playbook:{key}] best={t['best_model']} conf={t['confidence']} "
            f"rates={t['success_rate_by_model']} avoid={t['avoid']}"
        )
