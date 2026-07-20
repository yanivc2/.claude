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


# Non-path leak/replay markers (a "lesson" is a general rule, never a copied answer).
_FORBIDDEN = [
    (r"line\s*\d+", "line number"),
    (r"```", "code / patch block"),
    (r"assert\b", "test assertion / answer"),
    (r"==\s*[-\w']", "concrete expected value"),
    (r"\breturn\b", "code fragment"),
]

# Known source/config file extensions — used ONLY to recognise a filename or a path, never to
# reject a bare word. Prose extensions (.md/.txt/.rst) are deliberately excluded from the *bare*
# filename rule so ordinary words are not flagged; they still count when preceded by a separator.
_CODE_EXT = (r"(?:py|pyi|pyx|ipynb|json|toml|cfg|ini|yaml|yml|rs|js|jsx|ts|tsx|mjs|cjs|c|h|hpp|hh|"
             r"cpp|cc|cxx|go|java|kt|rb|php|pl|sh|bash|sql|xml|html|css)")

# PATH-AWARE leak detection (defect: the old rule rejected ANY "/", flagging natural-language
# technical phrasing like "parser/tokenizer", "stdout/stderr", "input/output"). A single slash
# between two ordinary words is NOT a path. A token is treated as a real path ONLY when it matches
# one of these general, task-agnostic shapes (fail-closed on anything that genuinely looks like a
# filesystem path, while letting a lone slash-joined word pair through):
_PATH_PATTERNS = [
    # leading ./  ../  /  or a Windows drive letter — the start of an absolute/relative path
    (r"(?:(?<=\s)|^)(?:\.{1,2}/|/|[A-Za-z]:[\\/])[\w.\-]", "absolute/relative/drive path"),
    # a chain of >=2 separators (src/pkg/mod, foo/bar/baz) — path-like structure, not prose
    (r"[\w.\-]+[\\/][\w.\-]+[\\/][\w.\-]+", "multi-segment path"),
    # a separator immediately followed by a filename with a known source/config extension
    (r"[\w.\-]+[\\/][\w.\-]*\." + _CODE_EXT + r"\b", "path to a source/config file"),
    # a bare source/config filename (e.g. solution.py, setup.cfg)
    (r"\b[\w\-]+\." + _CODE_EXT + r"\b", "source/config filename"),
    # a Windows-style backslash path segment
    (r"[\w.\-]+\\[\w.\-]+", "windows path"),
]


def _find_path_leak(blob: str) -> str | None:
    """Return the reason a real filesystem path was detected, else None (a lone slash-joined word
    pair such as ``parser/tokenizer`` is deliberately NOT a path)."""
    for pat, why in _PATH_PATTERNS:
        if re.search(pat, blob):
            return why
    return None


def validate_lesson(lesson: Lesson, forbidden_values: list[str] | None = None) -> None:
    """Raise LessonRejected if the lesson smuggles paths, code, or answers.

    ``forbidden_values`` lets the caller add task-specific leaks to reject (e.g. exact
    values from hidden tests). Path detection is path-aware (a single natural-language slash
    is allowed); a token that genuinely looks like a filesystem path is rejected fail-closed.
    """
    text_fields = [*lesson.recommended_action, *lesson.avoid,
                   *lesson.trigger.symptoms, *lesson.trigger.repo_traits]
    blob = " \n ".join(text_fields)
    for pat, why in _FORBIDDEN:
        if re.search(pat, blob):
            raise LessonRejected(f"lesson {lesson.lesson_id}: contains {why} (/{pat}/)")
    path_why = _find_path_leak(blob)
    if path_why:
        raise LessonRejected(f"lesson {lesson.lesson_id}: contains {path_why}")
    for val in forbidden_values or []:
        if val and val in blob:
            raise LessonRejected(f"lesson {lesson.lesson_id}: leaks hidden value {val!r}")
