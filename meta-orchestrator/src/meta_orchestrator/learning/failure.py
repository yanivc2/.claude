"""Failure taxonomy → memory-update mapping (SPEC §5.6, B2).

Each failure category updates memory differently. This module is the single source
of that policy; the post-mortem (C6) consumes it to decide how to update memory.
"""
from __future__ import annotations

from enum import Enum

from ..models import FailureCategory


class UpdateAction(str, Enum):
    """What a run outcome does to memory."""

    REWARD_MODEL = "reward_model"                # success: bandit success + write playbook lesson
    PENALIZE_MODEL = "penalize_model"            # bandit failure for (task_type, model)
    PENALIZE_MODEL_SOFT = "penalize_model_soft"  # subjective/weak signal: small penalty, needs repeats
    NOTE_COST_AVOID = "note_cost_avoid"          # too expensive: annotate playbook 'avoid on cost'
    NOTE_LATENCY_AVOID = "note_latency_avoid"    # too slow: annotate playbook 'avoid on latency'
    MARK_INCOMPLETE = "mark_incomplete"          # correct-but-incomplete: partial credit, re-plan hint


# Every FailureCategory must map to exactly one defined update action (B2 done-when).
FAILURE_UPDATE: dict[FailureCategory, UpdateAction] = {
    FailureCategory.NONE: UpdateAction.REWARD_MODEL,
    FailureCategory.TESTS_FAILED: UpdateAction.PENALIZE_MODEL,
    FailureCategory.FACTUAL_ERROR: UpdateAction.PENALIZE_MODEL,
    FailureCategory.USER_REJECTED: UpdateAction.PENALIZE_MODEL_SOFT,
    FailureCategory.TOO_EXPENSIVE: UpdateAction.NOTE_COST_AVOID,
    FailureCategory.TOO_SLOW: UpdateAction.NOTE_LATENCY_AVOID,
    FailureCategory.CORRECT_BUT_INCOMPLETE: UpdateAction.MARK_INCOMPLETE,
}


def update_action_for(category: FailureCategory) -> UpdateAction:
    return FAILURE_UPDATE[category]
