"""Structured procedural lessons (v2 §7) + forbidden-content validation.

A lesson is a GENERAL action rule, not a replay of a solution. It must never carry
line numbers, file paths, patches, test answers, values copied from hidden tests, or a
unique task name. ``validate_lesson`` enforces this so a "lesson" can't smuggle a
memorised answer past the abstraction boundary — the adversarial mock probes exactly this.
"""
from __future__ import annotations

import re

from pydantic import BaseModel, Field


class LessonTrigger(BaseModel):
    symptoms: list[str] = Field(default_factory=list)
    repo_traits: list[str] = Field(default_factory=list)


class LessonEvidence(BaseModel):
    supporting_runs: list[str] = Field(default_factory=list)
    successes: int = 0
    failures: int = 0


class Lesson(BaseModel):
    lesson_id: str
    task_family: str
    trigger: LessonTrigger = Field(default_factory=LessonTrigger)
    recommended_action: list[str] = Field(default_factory=list)
    avoid: list[str] = Field(default_factory=list)
    evidence: LessonEvidence = Field(default_factory=LessonEvidence)
    status: str = "candidate"              # candidate | active | deprecated
    version: int = 1


class LessonRejected(ValueError):
    """A proposed lesson contained forbidden (replay/leak) content."""


# Patterns that mark a "lesson" as leaking a specific answer rather than a general rule.
_FORBIDDEN = [
    (r"\.py\b", "file path / filename"),
    (r"/", "path separator"),
    (r"line\s*\d+", "line number"),
    (r"```", "code / patch block"),
    (r"assert\b", "test assertion / answer"),
    (r"==\s*[-\w']", "concrete expected value"),
    (r"\breturn\b", "code fragment"),
]


def validate_lesson(lesson: Lesson, forbidden_values: list[str] | None = None) -> None:
    """Raise LessonRejected if the lesson smuggles paths, code, or answers.

    ``forbidden_values`` lets the caller add task-specific leaks to reject (e.g. exact
    values from hidden tests).
    """
    text_fields = [*lesson.recommended_action, *lesson.avoid,
                   *lesson.trigger.symptoms, *lesson.trigger.repo_traits]
    blob = " \n ".join(text_fields)
    for pat, why in _FORBIDDEN:
        if re.search(pat, blob):
            raise LessonRejected(f"lesson {lesson.lesson_id}: contains {why} (/{pat}/)")
    for val in forbidden_values or []:
        if val and val in blob:
            raise LessonRejected(f"lesson {lesson.lesson_id}: leaks hidden value {val!r}")
