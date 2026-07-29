"""Hash-chained append-only run log + Authorization Anchor (refinement 2).

A hash chain detects an edit to a HISTORIC record, but not deletion of the TAIL: T0→T1→T2 with
T2 removed leaves a still-valid T0→T1. So each authorizing transition also mints a separate
``AuthorizationAnchor`` bound to the chain head + sequence + state; before every paid call the
runtime guard requires the live chain head/sequence/state to match the anchor exactly. A deleted
tail or a restored old file then mismatches the anchor.

Honest scope: this is corruption / accidental-edit / stale-restore detection inside the run
protocol — NOT defence against an adversary who rewrites the whole chain AND the anchors together.
Single operator, ~$5 run: a file lock + fsync + hash chain + anchor is sufficient; no external
signature or blockchain.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Optional

from pydantic import BaseModel, Field

from .gates import GateError

GENESIS = "GENESIS"


class ChainedTransition(BaseModel):
    sequence: int
    run_id: str
    previous_transition_hash: str
    previous_state: str
    new_state: str
    evidence_bundle_hash: str
    timestamp: str
    transition_hash: str = ""

    def compute_hash(self) -> str:
        payload = {k: v for k, v in self.model_dump().items() if k != "transition_hash"}
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]

    def sealed(self) -> "ChainedTransition":
        return self.model_copy(update={"transition_hash": self.compute_hash()})


class AuthorizationAnchor(BaseModel):
    run_id: str
    authorized_state: str
    expected_sequence: int
    expected_chain_head_hash: str
    evidence_bundle_hash: str

    def content_hash(self) -> str:
        return hashlib.sha256(
            json.dumps(self.model_dump(), sort_keys=True).encode()).hexdigest()[:16]


class RunLog:
    """Append-only JSONL of chained transitions. Status is derived ONLY from the verified chain."""

    def __init__(self, path: str, run_id: str) -> None:
        self.path = path
        self.run_id = run_id

    # --- append (safe) ---
    def append(self, *, new_state: str, evidence_bundle_hash: str, timestamp: str) -> ChainedTransition:
        chain = self.load()                       # verifies the existing chain first
        prev = chain[-1] if chain else None
        seq = (prev.sequence + 1) if prev else 0
        prev_hash = prev.transition_hash if prev else GENESIS
        prev_state = prev.new_state if prev else "UNAUTHORIZED_FOR_MESSAGES"
        t = ChainedTransition(sequence=seq, run_id=self.run_id, previous_transition_hash=prev_hash,
                              previous_state=prev_state, new_state=new_state,
                              evidence_bundle_hash=evidence_bundle_hash, timestamp=timestamp).sealed()
        line = json.dumps(t.model_dump(), sort_keys=True)
        # atomic-ish append: lock, write full line + newline, flush + fsync BEFORE returning.
        fd = os.open(self.path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
        try:
            _lock(fd)
            os.write(fd, (line + "\n").encode())
            os.fsync(fd)
        finally:
            _unlock(fd)
            os.close(fd)
        return t

    # --- load + verify ---
    def load(self) -> list[ChainedTransition]:
        if not os.path.exists(self.path):
            return []
        raw = open(self.path, "rb").read()
        if raw and not raw.endswith(b"\n"):
            raise GateError("run log ends with a partial line (crash mid-write) — blocked")
        rows: list[ChainedTransition] = []
        for i, line in enumerate(raw.decode().splitlines()):
            if not line.strip():
                continue
            t = ChainedTransition(**json.loads(line))
            if t.transition_hash != t.compute_hash():
                raise GateError(f"transition {i}: hash mismatch (record edited)")
            rows.append(t)
        self._verify_chain(rows)
        return rows

    def _verify_chain(self, rows: list[ChainedTransition]) -> None:
        prev_hash = GENESIS
        prev_state = "UNAUTHORIZED_FOR_MESSAGES"
        for i, t in enumerate(rows):
            if t.run_id != self.run_id:
                raise GateError(f"transition {i}: run_id {t.run_id!r} != {self.run_id!r}")
            if t.sequence != i:
                raise GateError(f"transition {i}: non-contiguous sequence {t.sequence}")
            if t.previous_transition_hash != prev_hash:
                raise GateError(f"transition {i}: broken chain link")
            if t.previous_state != prev_state:
                raise GateError(f"transition {i}: previous_state drift")
            prev_hash, prev_state = t.transition_hash, t.new_state

    def head(self) -> tuple[str, int, str]:
        """(chain_head_hash, sequence, state) — GENESIS/-1/UNAUTHORIZED for an empty log."""
        chain = self.load()
        if not chain:
            return GENESIS, -1, "UNAUTHORIZED_FOR_MESSAGES"
        last = chain[-1]
        return last.transition_hash, last.sequence, last.new_state

    def current_state(self) -> str:
        return self.head()[2]


def make_anchor(run_log: RunLog, *, authorized_state: str, evidence_bundle_hash: str
                ) -> AuthorizationAnchor:
    head_hash, seq, state = run_log.head()
    if state != authorized_state:
        raise GateError(f"cannot anchor {authorized_state!r}: chain head state is {state!r}")
    return AuthorizationAnchor(run_id=run_log.run_id, authorized_state=authorized_state,
                               expected_sequence=seq, expected_chain_head_hash=head_hash,
                               evidence_bundle_hash=evidence_bundle_hash)


def verify_anchor(run_log: RunLog, anchor: AuthorizationAnchor) -> None:
    """Runtime guard: the live chain must match the anchor EXACTLY (detects tail deletion / restore)."""
    head_hash, seq, state = run_log.head()
    if anchor.run_id != run_log.run_id:
        raise GateError("anchor run_id mismatch")
    if anchor.expected_chain_head_hash != head_hash:
        raise GateError("chain head hash != authorization anchor (tail deleted or file restored)")
    if anchor.expected_sequence != seq:
        raise GateError("chain sequence != authorization anchor")
    if anchor.authorized_state != state:
        raise GateError("chain state != authorization anchor")


def _lock(fd: int) -> None:
    try:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX)
    except Exception:
        pass                                       # best-effort on platforms without fcntl


def _unlock(fd: int) -> None:
    try:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)
    except Exception:
        pass
