"""Execution grant (P0.5) — the narrow, separately-minted authorization that actually opens spend.

The Gate-1 authorization anchor proves the DESIGN is fundable and passed all checks; by explicit
policy it must NOT by itself enable a paid call. An ``ExecutionGrant`` is a SECOND artifact, minted
only by a separate explicit human go, scoped to exactly one fold/condition/phase/task with hard
attempt + message-call caps, and bound to the anchor it authorizes under. ``assert_call_allowed``
requires a live grant whose scope contains the requested call; absent it, every ``messages.create``
is blocked (fail-closed).

Minting a grant is a distinct step from minting the anchor and from sending a call. This module only
builds/validates grants; it performs no network or paid call.
"""
from __future__ import annotations

import hashlib
import json

from pydantic import BaseModel


class ExecutionGrant(BaseModel):
    grant_version: str = "s2-exec-grant-v1"
    anchor_commit: str                     # the Gate-1 evidence commit this grant is bound to
    anchor_report_hash: str                # the Gate-1 report hash this grant authorizes under
    fold: int
    condition: str                         # e.g. "C"
    phase: str                             # e.g. "training"
    task_id: str                           # exactly one task
    max_tasks: int = 1
    max_attempts: int = 1
    max_messages_calls: int = 2            # R1 + optional R2
    granted_by: str = "operator"
    granted_at: str
    content_hash: str = ""

    def compute_hash(self) -> str:
        payload = {k: v for k, v in self.model_dump().items() if k != "content_hash"}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    def sealed(self) -> "ExecutionGrant":
        return self.model_copy(update={"content_hash": self.compute_hash()})

    def is_sealed(self) -> bool:
        return bool(self.content_hash) and self.content_hash == self.compute_hash()

    def covers(self, *, fold: int, condition: str, task_id: str, calls_used: int) -> bool:
        """True iff a call for (fold, condition, task_id) after ``calls_used`` prior calls is in scope."""
        return (self.is_sealed() and self.fold == fold and self.condition == condition
                and self.task_id == task_id and calls_used < self.max_messages_calls)


def build_execution_grant(*, anchor_commit: str, anchor_report_hash: str, fold: int, condition: str,
                          phase: str, task_id: str, granted_at: str, granted_by: str = "operator",
                          max_attempts: int = 1, max_messages_calls: int = 2) -> ExecutionGrant:
    """Mint a single-task execution grant bound to a specific Gate-1 anchor. Explicit-go only."""
    return ExecutionGrant(
        anchor_commit=anchor_commit, anchor_report_hash=anchor_report_hash, fold=fold,
        condition=condition, phase=phase, task_id=task_id, max_tasks=1, max_attempts=max_attempts,
        max_messages_calls=max_messages_calls, granted_by=granted_by, granted_at=granted_at).sealed()
