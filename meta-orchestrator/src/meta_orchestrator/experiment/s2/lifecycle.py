"""Condition-C learning lifecycle (Decision D): learn → freeze → held-out with NO writes.

Per fold, C starts from EMPTY memory, learns gated procedural lessons from the fold's train
tasks only, groups them by family, and freezes the bank. Held-out evaluation then injects the
frozen family lessons and never writes memory (the bank is frozen; a write raises). Re-running
held-out with the same frozen bank measures *execution* stability, not learning stability.

Offline, ``MockLearner`` stands in for a real solver's lesson proposals: it emits one generic,
abstraction-safe lesson per family present in train (passes ``validate_lesson`` — no paths,
code, values, or answers). It encodes NO task-specific answer; it only tags a family so the
routing plumbing has something family-shaped to move around.
"""
from __future__ import annotations

from typing import Callable, Optional

from ..lesson import Lesson, LessonTrigger, validate_lesson
from ..task import ExperimentTask
from .memory import FrozenLessonBank

# A learner maps a train task → an optional proposed lesson.
Learner = Callable[[ExperimentTask], Optional[Lesson]]


class MockLearner:
    """Deterministic, abstraction-safe lesson proposer for the offline harness."""

    def __call__(self, task: ExperimentTask) -> Optional[Lesson]:
        fam = task.task_family
        # Text is deliberately generic and forbidden-pattern-free (no path/code/value/answer).
        return Lesson(
            lesson_id=f"L-{fam}",
            task_family=fam,
            trigger=LessonTrigger(symptoms=[f"output differs from expectation in {fam} cases"]),
            recommended_action=["prefer a minimal targeted edit over a broad rewrite",
                                 "re-run the public suite before finalizing"],
            avoid=["sweeping edits across unrelated code"],
            status="active",
        )


def learn_bank(
    train_tasks: list[ExperimentTask],
    learner: Learner,
    *,
    forbidden_values: Optional[list[str]] = None,
) -> FrozenLessonBank:
    """Learn from train only, gate each lesson, dedupe by (family, lesson_id), freeze."""
    by_family: dict[str, dict[str, Lesson]] = {}
    for task in train_tasks:
        proposed = learner(task)
        if proposed is None:
            continue
        try:
            validate_lesson(proposed, forbidden_values)      # anti-contamination gate
        except ValueError:
            continue                                          # rejected lessons never enter the bank
        by_family.setdefault(proposed.task_family, {})[proposed.lesson_id] = proposed
    grouped = {fam: list(d.values()) for fam, d in by_family.items()}
    return FrozenLessonBank(by_family=grouped, frozen=True)
