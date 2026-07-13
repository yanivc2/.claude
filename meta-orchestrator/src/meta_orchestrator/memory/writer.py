"""Memory-write pipeline (SPEC §5.10, B4).

Order: extract → classify → dedupe → **success-signal check** → confidence → expiry →
**write only after confirmation**. A lesson is written ONLY when the objective signal
is positive (verify passed) AND a confirm callback approves it. Unverified lessons are
rejected — this is "verification before memory" (SPEC principle §4.4).
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Callable, Optional

from ..learning.bandit import BanditBook
from ..models import PlaybookEntry, TaskClassification, VerifyResult
from ..persistence.store import Store
from ..utils import now_iso

# A confirm hook: receives the extracted lesson, returns True to allow the write.
ConfirmFn = Callable[[dict[str, Any]], bool]


def always_confirm(_lesson: dict[str, Any]) -> bool:
    return True


class MemoryWriter:
    def __init__(self, store: Store, max_confidence: float = 0.95) -> None:
        self._store = store
        self._max_conf = max_confidence

    def _extract_lesson(
        self, classification: TaskClassification, chosen_model: str,
        verify_result: VerifyResult, cost: float,
    ) -> dict[str, Any]:
        """Extract a compact, structured lesson from a run outcome."""
        return {
            "task_type": classification.labels[-1] if classification.labels else "Unknown",
            "chosen_model": chosen_model,
            "passed": verify_result.passed,
            "cost": cost,
            "evidence": verify_result.evidence[:2],
        }

    def write(
        self,
        *,
        classification: TaskClassification,
        chosen_model: str,
        verify_result: VerifyResult,
        bandit: BanditBook,
        confirm: ConfirmFn = always_confirm,
        cost: float = 0.0,
        ttl_days: int = 30,
    ) -> Optional[PlaybookEntry]:
        """Run the pipeline. Returns the written entry, or None if the lesson was rejected."""
        # 1. extract
        lesson = self._extract_lesson(classification, chosen_model, verify_result, cost)
        # 2. classify → memory key
        key = classification.playbook_key()
        task_type = lesson["task_type"]
        # 3. dedupe → load existing entry to merge into (keyed → idempotent merge)
        existing = self._store.get_playbook(key)

        # 4. SUCCESS-SIGNAL GATE (objective dimension, §5.3): only positive, verified
        #    outcomes become lessons. Everything else is rejected here.
        if not verify_result.passed:
            return None

        # 5. confidence: grows with consistent verified confirmations (§5.5 — a single
        #    confirmation is weak; require repeats). Uses accumulated success count.
        content: dict[str, Any] = dict(existing.content) if existing else {}
        verified_successes = int(content.get("verified_successes", 0)) + 1
        confidence = min(self._max_conf, 1.0 - 1.0 / (1.0 + verified_successes))

        # snapshot the bandit's current best model for this task type into Tier-1.
        stats = self._store.list_bandit_stats(task_type)
        rates = {s.model_id: round(s.mean, 4) for s in stats}
        best_model = max(rates, key=rates.get) if rates else chosen_model

        content.update(
            {
                "task_type": task_type,
                "verified_successes": verified_successes,
                "best_model": best_model,
                "success_rate_by_model": rates,
                "last_cost": cost,
                "note": f"verified fix via {chosen_model}",
            }
        )

        # 6. expiry (staleness policy, §5.9)
        expiry = (date.fromisoformat(now_iso()[:10]) + timedelta(days=ttl_days)).isoformat()

        # 7. confirmation gate: nothing is written unless confirm() approves (§5.10).
        if not confirm(lesson):
            return None

        entry = PlaybookEntry(
            key=key,
            content=content,
            confidence=confidence,
            expiry=expiry,
            version=(existing.version + 1) if existing else 1,
            updated_at=now_iso(),
        )
        self._store.upsert_playbook(entry)
        return entry
