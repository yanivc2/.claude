"""Seed task definition + objective success rule (A2).

A ``BugCase`` bundles buggy source + a pytest suite that fails against the bug and
passes against a correct fix. Success is defined by RUNNING that suite (see §5.4
verifier in Milestone B1) — this module holds the data shape and the written rule.
"""
from __future__ import annotations

from pydantic import BaseModel

from ..taxonomy import SEED_TASK_TYPE


class BugCase(BaseModel):
    """One instance of the code-fix seed task."""

    bug_id: str
    category: str            # e.g. "off_by_one", "wrong_operator", "wrong_return"
    module_filename: str     # e.g. "solution.py"
    module_source: str       # buggy source
    test_source: str         # pytest suite: fails on bug, passes on correct fix
    # The known-good fix, used ONLY by the deterministic mock adapter to decide
    # whether a given mock model "solves" this case (never read by the verifier).
    reference_fix: str


SEED_SUCCESS_RULE = (
    "passed  <=>  every test in test_source passes (pytest exit code 0) "
    "AND the candidate module imports without error. "
    "This is the objective dimension (SPEC §5.3): it always runs and cannot be "
    "overridden by user preference. There is no subjective dimension for this task."
)


def describe_seed_task() -> dict:
    """Machine-readable A2 definition: what the task is + when it succeeds."""
    return {
        "task_type": SEED_TASK_TYPE,
        "what": (
            "Given a buggy Python module and a pytest suite that fails against it, "
            "produce a corrected module."
        ),
        "success_rule": SEED_SUCCESS_RULE,
        "signal": "objective/binary, measured by actually running pytest",
        "breadth": {
            "verifiable": "yes",
            "risk": "low",
            "needs_live_data": False,
            "subjective_dimension": False,
        },
    }
