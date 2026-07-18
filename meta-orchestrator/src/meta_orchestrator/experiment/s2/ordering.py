"""Counterbalanced execution order + infra-error policy (frozen pre-paid, GPT review items B/C).

Two unmentioned confounds the consultation flagged:

  * **Execution order.** If every held-out task always ran A→C→D→B1, provider load / rate
    limiting / time drift would correlate with condition. ``condition_order`` gives each task a
    deterministic Latin-square rotation so the four conditions are balanced across positions —
    fixed by the task id, reproducible, and chosen with NO reference to outcomes.
  * **Curriculum order.** C learns sequentially, so the frozen bank depends on the train order.
    ``train_order`` pins one deterministic order per fold; the experiment then estimates
    performance under that single frozen curriculum (documented, not hidden).

Infra-error policy: an infrastructure failure (timeout, SDK/API error, sandbox failure) must
NEVER be recorded as a condition-specific solver FAIL — that would bias the paired comparison.
``classify_attempt_outcome`` maps a public-status + verdict into {solver_pass, solver_fail,
incomplete}; ``RETRY_POLICY`` is the single, condition-blind retry rule.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel

# One fixed, condition-blind retry rule for infrastructure errors (frozen).
RETRY_POLICY = {
    "max_retries": 2,
    "retry_on": ["INFRA_ERROR", "api_timeout", "sdk_exception", "rate_limit", "sandbox_failure"],
    "retry_is_condition_blind": True,       # identical for A/C/D/B1
    "reuse_request": True,                   # same frozen request/seed on retry
    "on_exhausted": "withhold_paired_task",  # drop the task's paired comparison, never count FAIL
}

CONDITION_ORDER_VERSION = "latin-square-v1"


def condition_order(task_id: str, conditions: Optional[list[str]] = None) -> list[str]:
    """Deterministic per-task rotation of the conditions (a Latin-square row). Outcome-independent.

    The rotation offset is a stable hash of the task id, so across many tasks each condition lands
    in each position with equal frequency, while any single task's order is fixed + reproducible.
    """
    conds = list(conditions) if conditions is not None else ["A", "C", "D", "B1"]
    n = len(conds)
    # stable, platform-independent offset (NOT Python's salted hash()).
    import hashlib
    h = int(hashlib.sha256(task_id.encode("utf-8")).hexdigest(), 16)
    off = h % n
    return conds[off:] + conds[:off]


def train_order(train_ids: list[str]) -> list[str]:
    """The frozen curriculum order for C's sequential learning in a fold (deterministic)."""
    return sorted(train_ids)          # one pinned order; documented single-curriculum estimand


class AttemptOutcome(BaseModel):
    status: str            # "solver_pass" | "solver_fail" | "incomplete"
    reason: str = ""
    counts_in_paired_analysis: bool = True


def classify_attempt_outcome(public_status: str, verdict_passed: Optional[bool],
                             *, infra: bool = False) -> AttemptOutcome:
    """Map a bounded attempt's signals into an outcome that NEVER turns infra into a FAIL.

    - INFRA_ERROR (or explicit infra flag) → incomplete, withheld from the paired analysis.
    - otherwise the hidden verifier decides: passed → solver_pass, else → solver_fail.
    A NO_PUBLIC_TESTS public status is NOT infra and NOT a fail on its own — the hidden verifier
    still decides correctness.
    """
    if infra or public_status == "INFRA_ERROR":
        return AttemptOutcome(status="incomplete", reason="infrastructure error (retry policy)",
                              counts_in_paired_analysis=False)
    if verdict_passed is None:
        return AttemptOutcome(status="incomplete", reason="no verdict",
                              counts_in_paired_analysis=False)
    return AttemptOutcome(status="solver_pass" if verdict_passed else "solver_fail",
                          reason="hidden verifier")
