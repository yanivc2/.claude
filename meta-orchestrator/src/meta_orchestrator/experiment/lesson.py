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

# FROZEN, explicit source/config extension allowlist (leak-screen v2 clarification A). Used ONLY to
# recognise a filename or a path, never to reject an arbitrary dotted word — so ordinary prose like
# "e.g.", "i.e.", "version.2" is never misclassified. Prose extensions (.md/.txt/.rst) are excluded
# from the *bare* filename rule; they still count when preceded by a path separator.
_CODE_EXT = (r"(?:py|pyi|pyx|ipynb|js|jsx|ts|tsx|java|go|rs|rb|php|c|cc|cpp|h|hpp|cs|sh|"
             r"toml|yaml|yml|json|ini|cfg|xml)")

# A URI with an explicit scheme (http://, https://, git+ssh://, …). Clarification B: a URL is NOT a
# repository-path leak merely because it contains several separators — it is waived from the
# multi-segment-chain rule, but is STILL rejected if it embeds a real source path/filename
# (the extension rule below fires inside it) or an exact frozen value (forbidden_values).
_URI_RE = re.compile(r"\b[a-z][a-z0-9+.\-]*://\S+", re.IGNORECASE)

# PATH-AWARE leak detection (defect: the old rule rejected ANY "/", flagging natural-language
# technical phrasing like "parser/tokenizer", "stdout/stderr", "input/output"). A single slash
# between two ordinary words is NOT a path. A token is treated as a real path ONLY when it matches
# one of these general, task-agnostic shapes (fail-closed on anything that genuinely looks like a
# filesystem path, while letting a lone slash-joined word pair through). ``waive_in_uri`` marks the
# rules that must NOT fire merely because a match sits inside a scheme:// URL (clarification B).
_PATH_PATTERNS = [
    # leading ./  ../  /  or a Windows drive letter — the start of an absolute/relative path
    (r"(?:(?<=\s)|^)(?:\.{1,2}/|/|[A-Za-z]:[\\/])[\w.\-]", "absolute/relative/drive path", False),
    # a chain of >=2 separators (src/pkg/mod, foo/bar/baz) — path-like structure, not prose
    (r"[\w.\-]+[\\/][\w.\-]+[\\/][\w.\-]+", "multi-segment path", True),
    # a separator immediately followed by a filename with a known source/config extension
    (r"[\w.\-]+[\\/][\w.\-]*\." + _CODE_EXT + r"\b", "path to a source/config file", False),
    # a bare source/config filename (e.g. solution.py, setup.cfg)
    (r"\b[\w\-]+\." + _CODE_EXT + r"\b", "source/config filename", False),
    # a Windows-style backslash path segment
    (r"[\w.\-]+\\[\w.\-]+", "windows path", False),
]


def _find_path_leak(blob: str) -> str | None:
    """Return the reason a real filesystem path was detected, else None (a lone slash-joined word
    pair such as ``parser/tokenizer`` is deliberately NOT a path; a scheme:// URL is not a repo path
    merely by its separator count, but still leaks if it embeds a source path/filename)."""
    uri_spans = [m.span() for m in _URI_RE.finditer(blob)]

    def _inside_uri(span: tuple[int, int]) -> bool:
        return any(s <= span[0] and span[1] <= e for s, e in uri_spans)

    for pat, why, waive_in_uri in _PATH_PATTERNS:
        for m in re.finditer(pat, blob):
            if waive_in_uri and _inside_uri(m.span()):
                continue                     # a URL is not a repo path merely by separator count
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
