"""LEGACY — do not use for new integrations.

Superseded by :mod:`meta_orchestrator.planner.governance`, which is the canonical path
for every new consumer. This package stays for the tests already written against it and
for backward compatibility; it gets no persistence of its own, no new features, and no
place in the orchestrator integration.

What ``governance`` has that this does not: an explicit spend purpose, canonical
budget and plan snapshots, full approval binding, stale-state refusal, execution
authorizations, the override cascade, and transactional persistence. Those are not
additions to this layer — they change what an approval *means*, which is why the new
path replaces this one rather than extending it.

Approval (P1c) — turning a costed plan into a decision, and a decision into
permission.

Nothing executes without a record that covers the exact run: same plan, same version,
same hash, same mode, projection inside the approved cap, not expired. Editing an
approved plan withdraws its approval by construction, because the approval binds to a
plan hash.

Records are append-only. A changed mind is a new record that supersedes the old one,
and both stay readable — an authorisation that can be quietly widened after the fact
authorises nothing.

Decides and records only. Does not execute, and is not wired to the orchestrator.
"""
from __future__ import annotations

from .errors import (
    ApprovalGateError,
    DecisionAlreadyRecordedError,
    DecisionMismatchError,
    UnknownApprovalRequestError,
)
from .gate import ApprovalGate, approve, reject
from .store import ApprovalLog

__all__ = [
    "ApprovalGate", "ApprovalLog", "approve", "reject",
    "ApprovalGateError", "UnknownApprovalRequestError",
    "DecisionAlreadyRecordedError", "DecisionMismatchError",
]
