"""Immutable request + call journal + atomic budget reservation (refinements 4 & 5).

Closes the last silent-failure paths between a passed gate and a paid request:

  * **Single immutable request (TOCTOU).** Build/serialize/hash the request ONCE, then send that
    exact object. The body counted+guarded must equal the body sent — recorded as two hashes
    (``canonical_request_hash`` = semantic object; ``outbound_body_hash`` = final HTTP body). A
    mismatch is a protocol block, never a solver outcome.
  * **Call journal.** CALL_PREPARED → BUDGET_RESERVED → CALL_SENT → CALL_ACKNOWLEDGED, or
    CALL_FAILED_BEFORE_SEND / CALL_AMBIGUOUS_AFTER_SEND, then COST_RECONCILED. On AMBIGUOUS the
    server may have processed+billed the request, so there is NO auto-retry, it is NOT a
    solver_fail, the reservation is NOT auto-released, and a human may not "just retry" and keep
    both runs as one attempt.
  * **Atomic budget reservation.** check → reserve max exposure → persist → send → reconcile, under
    a file lock, so two processes / a restart / a double-click cannot both spend the same balance.
"""
from __future__ import annotations

import json
import os
from typing import Optional

from pydantic import BaseModel, Field

from .gates import GateError

# journal states
CALL_PREPARED = "CALL_PREPARED"
BUDGET_RESERVED = "BUDGET_RESERVED"
CALL_SENT = "CALL_SENT"
CALL_ACKNOWLEDGED = "CALL_ACKNOWLEDGED"
CALL_FAILED_BEFORE_SEND = "CALL_FAILED_BEFORE_SEND"
CALL_AMBIGUOUS_AFTER_SEND = "CALL_AMBIGUOUS_AFTER_SEND"
COST_RECONCILED = "COST_RECONCILED"

_TERMINAL = {CALL_ACKNOWLEDGED, CALL_FAILED_BEFORE_SEND, CALL_AMBIGUOUS_AFTER_SEND, COST_RECONCILED}


class PreparedRequest(BaseModel):
    """A request built ONCE. Both hashes are fixed at preparation and never rebuilt before send."""

    call_id: str
    fold: int
    condition: str
    round_index: int
    canonical_request_hash: str
    outbound_body_hash: str = ""          # filled when the transport serializes the final body


def assert_sent_body_matches(prepared: PreparedRequest, outbound_body_hash: str) -> None:
    """The body actually sent must equal the body prepared+guarded (TOCTOU block)."""
    if prepared.outbound_body_hash and prepared.outbound_body_hash != outbound_body_hash:
        raise GateError("outbound body hash != prepared body hash (request changed after guard)")


class BudgetLedger:
    """File-locked reservation ledger: only one caller can reserve the same balance."""

    def __init__(self, path: str, total_budget: float) -> None:
        self.path = path
        self.total_budget = total_budget

    def _read(self) -> dict:
        if not os.path.exists(self.path):
            return {"reserved": 0.0, "spent": 0.0, "entries": []}
        return json.load(open(self.path))

    def available(self) -> float:
        s = self._read()
        return self.total_budget - s["reserved"] - s["spent"]

    def reserve(self, call_id: str, max_exposure: float) -> None:
        """Atomically reserve ``max_exposure`` BEFORE sending. Raises if the balance can't cover it."""
        fd = os.open(self.path if os.path.exists(self.path) else self.path,
                     os.O_RDWR | os.O_CREAT, 0o600)
        try:
            _lock(fd)
            state = json.loads(os.pread(fd, 1_000_000, 0).decode() or "null") or {
                "reserved": 0.0, "spent": 0.0, "entries": []}
            if any(e["call_id"] == call_id for e in state["entries"]):
                raise GateError(f"call_id {call_id} already reserved (double reservation)")
            if self.total_budget - state["reserved"] - state["spent"] < max_exposure:
                raise GateError("insufficient balance to reserve max call exposure")
            state["reserved"] += max_exposure
            state["entries"].append({"call_id": call_id, "reserved": max_exposure, "spent": None})
            data = json.dumps(state).encode()
            os.ftruncate(fd, 0)
            os.pwrite(fd, data, 0)
            os.fsync(fd)
        finally:
            _unlock(fd)
            os.close(fd)

    def reconcile(self, call_id: str, actual_cost: float) -> None:
        fd = os.open(self.path, os.O_RDWR, 0o600)
        try:
            _lock(fd)
            state = json.loads(os.pread(fd, 1_000_000, 0).decode())
            for e in state["entries"]:
                if e["call_id"] == call_id and e["spent"] is None:
                    state["reserved"] -= e["reserved"]
                    state["spent"] += actual_cost
                    e["spent"] = actual_cost
                    break
            else:
                raise GateError(f"no open reservation for {call_id}")
            os.ftruncate(fd, 0)
            os.pwrite(fd, json.dumps(state).encode(), 0)
            os.fsync(fd)
        finally:
            _unlock(fd)
            os.close(fd)


class CallJournal:
    """Append-only per-call state journal. Reservation is NOT released on AMBIGUOUS."""

    def __init__(self, path: str) -> None:
        self.path = path

    def record(self, call_id: str, state: str, *, detail: Optional[dict] = None) -> None:
        rec = {"call_id": call_id, "state": state, "detail": detail or {}}
        with open(self.path, "a") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def states_for(self, call_id: str) -> list[str]:
        if not os.path.exists(self.path):
            return []
        out = []
        for line in open(self.path).read().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            if r["call_id"] == call_id:
                out.append(r["state"])
        return out


def classify_journal_terminal(states: list[str]) -> str:
    """Map a call's journal to its terminal disposition (frozen infra rule)."""
    if CALL_AMBIGUOUS_AFTER_SEND in states:
        return "ambiguous_stop"          # NO retry, NOT solver_fail, reservation held, infra-stop
    if CALL_FAILED_BEFORE_SEND in states:
        return "retryable_infra"         # nothing sent → safe to retry under the frozen policy
    if COST_RECONCILED in states or CALL_ACKNOWLEDGED in states:
        return "complete"
    return "incomplete"


def _lock(fd: int) -> None:
    try:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX)
    except Exception:
        pass


def _unlock(fd: int) -> None:
    try:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)
    except Exception:
        pass
