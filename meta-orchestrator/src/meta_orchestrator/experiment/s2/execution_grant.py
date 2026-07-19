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
import os

from pydantic import BaseModel

from .gates import GateError


class ExecutionGrant(BaseModel):
    grant_version: str = "s2-exec-grant-v1"
    grant_id: str                          # unique id → keyed in the persistent usage ledger
    anchor_commit: str                     # the Gate-1 evidence commit this grant is bound to
    anchor_report_hash: str                # the Gate-1 report hash this grant authorizes under
    fold: int
    condition: str                         # e.g. "C"
    phase: str                             # e.g. "training"
    task_id: str                           # exactly one LITERAL task id
    curriculum_hash: str = ""              # the frozen curriculum this task id came from
    curriculum_position: int = 0           # its frozen position (not a runtime sort)
    max_tasks: int = 1
    max_attempts: int = 1
    max_messages_calls: int = 2            # R1 + optional R2
    max_total_exposure_usd: str = ""       # the frozen R1+R2 worst exposure reserved atomically
    model_id: str = ""
    reproduction_digest: str = ""          # the task's verified reproduction-environment digest
    task_2_authorized: bool = False        # the next task is NEVER authorized by this grant
    expires_at: str = ""                   # optional run-session binding
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


def build_execution_grant(*, grant_id: str, anchor_commit: str, anchor_report_hash: str, fold: int,
                          condition: str, phase: str, task_id: str, granted_at: str,
                          curriculum_hash: str = "", curriculum_position: int = 0,
                          max_total_exposure_usd: str = "", model_id: str = "",
                          reproduction_digest: str = "", granted_by: str = "operator",
                          max_attempts: int = 1, max_messages_calls: int = 2,
                          expires_at: str = "") -> ExecutionGrant:
    """Mint a single-task execution grant bound to a specific Gate-1 anchor. Explicit-go only."""
    return ExecutionGrant(
        grant_id=grant_id, anchor_commit=anchor_commit, anchor_report_hash=anchor_report_hash,
        fold=fold, condition=condition, phase=phase, task_id=task_id,
        curriculum_hash=curriculum_hash, curriculum_position=curriculum_position, max_tasks=1,
        max_attempts=max_attempts, max_messages_calls=max_messages_calls,
        max_total_exposure_usd=max_total_exposure_usd, model_id=model_id,
        reproduction_digest=reproduction_digest, granted_by=granted_by, granted_at=granted_at,
        expires_at=expires_at, task_2_authorized=False).sealed()


class GrantUsageLedger:
    """Persistent, atomic, file-locked usage counter — makes a grant NON-replayable.

    A sealed grant is cryptographically valid forever; a static check cannot stop it being replayed
    across processes / restarts. This ledger binds a per-``grant_id`` call counter + completion flag
    to a stable file (fsync'd under an exclusive lock), so: the call cap is enforced across restarts,
    a completed task can never be re-run under the same grant, and two processes cannot both spend the
    same call. ``authorize_and_record`` is the ONLY way to consume a call; it raises on any violation.
    """

    def __init__(self, path: str) -> None:
        self.path = path

    def _read(self) -> dict:
        if not os.path.exists(self.path):
            return {}
        try:
            return json.load(open(self.path))
        except Exception:
            raise GateError("grant usage ledger unreadable/corrupt — blocked")

    def calls_used(self, grant_id: str) -> int:
        return int(self._read().get(grant_id, {}).get("calls", 0))

    def is_completed(self, grant_id: str) -> bool:
        return bool(self._read().get(grant_id, {}).get("completed", False))

    def would_authorize(self, grant: "ExecutionGrant", *, fold: int, condition: str,
                        task_id: str) -> bool:
        """Read-only scope+cap check against the PERSISTENT counter (used to set the guard flag)."""
        st = self._read().get(grant.grant_id, {})
        if st.get("completed"):
            return False
        return grant.covers(fold=fold, condition=condition, task_id=task_id,
                            calls_used=int(st.get("calls", 0)))

    def authorize_and_record(self, grant: "ExecutionGrant", *, fold: int, condition: str,
                             task_id: str) -> int:
        """Atomically consume ONE call under an exclusive lock. Raises on scope/cap/replay violation."""
        try:
            import fcntl
        except Exception:                                    # pragma: no cover
            fcntl = None
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_EX)
            raw = os.read(fd, 10_000_000).decode() or "{}"
            data = json.loads(raw) if raw.strip() else {}
            st = data.get(grant.grant_id, {"calls": 0, "completed": False})
            if st.get("completed"):
                raise GateError(f"grant {grant.grant_id} already completed — non-replayable")
            used = int(st.get("calls", 0))
            if not grant.covers(fold=fold, condition=condition, task_id=task_id, calls_used=used):
                raise GateError(
                    f"grant {grant.grant_id} does not cover (fold={fold}, cond={condition}, "
                    f"task={task_id}, calls_used={used}) — blocked")
            st["calls"] = used + 1
            data[grant.grant_id] = st
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, 0)
            os.write(fd, json.dumps(data).encode())
            os.fsync(fd)
            return st["calls"]
        finally:
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def mark_complete(self, grant: "ExecutionGrant") -> None:
        """Seal the grant against replay once its task reaches a terminal outcome."""
        try:
            import fcntl
        except Exception:                                    # pragma: no cover
            fcntl = None
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_EX)
            raw = os.read(fd, 10_000_000).decode() or "{}"
            data = json.loads(raw) if raw.strip() else {}
            st = data.get(grant.grant_id, {"calls": 0, "completed": False})
            st["completed"] = True
            data[grant.grant_id] = st
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, 0)
            os.write(fd, json.dumps(data).encode())
            os.fsync(fd)
        finally:
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
