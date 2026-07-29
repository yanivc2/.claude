"""B2: every failure category maps to a defined memory-update action."""
from __future__ import annotations

from meta_orchestrator.learning.failure import FAILURE_UPDATE, UpdateAction, update_action_for
from meta_orchestrator.models import FailureCategory


def test_every_category_is_mapped():
    for cat in FailureCategory:
        assert cat in FAILURE_UPDATE
        assert isinstance(update_action_for(cat), UpdateAction)


def test_key_mappings():
    assert update_action_for(FailureCategory.NONE) == UpdateAction.REWARD_MODEL
    assert update_action_for(FailureCategory.TESTS_FAILED) == UpdateAction.PENALIZE_MODEL
    assert update_action_for(FailureCategory.FACTUAL_ERROR) == UpdateAction.PENALIZE_MODEL
    assert update_action_for(FailureCategory.TOO_EXPENSIVE) == UpdateAction.NOTE_COST_AVOID
    assert update_action_for(FailureCategory.CORRECT_BUT_INCOMPLETE) == UpdateAction.MARK_INCOMPLETE
