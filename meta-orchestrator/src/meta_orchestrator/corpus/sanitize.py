"""Problem-statement sanitization (v2-corpus §7).

Commit/PR text often leaks the solution (exact function name, root cause, the recommended
patch). Keep two versions: raw (evaluator-only) and sanitized (given to the agent).
Reject statements that become — or already are — too vague to diagnose from ("fix edge
case"): a task with no usable signal isn't a fair bugfix task.
"""
from __future__ import annotations

import re

from pydantic import BaseModel, Field

from .models import CandidateTask

_SENTENCE_LEAKS = [
    (re.compile(r"(?i)\bthe fix is\b[^.]*\.?"), "removed suggested fix"),
    (re.compile(r"(?i)\bchange\b[^.]*\bto\b[^.]*\.?"), "removed change instruction"),
    (re.compile(r"(?i)\broot cause\b[^.]*\.?"), "removed root-cause disclosure"),
]
_FILE_REF = re.compile(r"\b[\w/]+\.py\b")
_VAGUE = {"", "fix edge case", "fix bug", "fix it", "bugfix", "fix"}
_IDENT = re.compile(r"[A-Za-z_]\w{2,}")


class SanitizeResult(BaseModel):
    sanitized: str
    log: list[str] = Field(default_factory=list)
    usable: bool = True                    # False → statement too vague to diagnose (reject)


def _added_identifiers(candidate: CandidateTask) -> set[str]:
    buggy = " ".join(candidate.buggy_source.values())
    fixed = " ".join(candidate.fixed_source.values())
    added = set(_IDENT.findall(fixed)) - set(_IDENT.findall(buggy))
    common = {"def", "return", "self", "None", "True", "False", "int", "str", "range", "len"}
    return {t for t in added if len(t) >= 4 and t not in common}


def sanitize_statement(candidate: CandidateTask) -> SanitizeResult:
    text = candidate.problem_statement_raw
    log: list[str] = []

    # Replace file references first so "solution.py" doesn't split a leak sentence mid-word.
    if _FILE_REF.search(text):
        text = _FILE_REF.sub("the module", text)
        log.append("removed file reference")
    for pat, why in _SENTENCE_LEAKS:
        if pat.search(text):
            text = pat.sub(" ", text)
            log.append(why)
    for ident in _added_identifiers(candidate):
        if re.search(rf"\b{re.escape(ident)}\b", text):
            text = re.sub(rf"\b{re.escape(ident)}\b", "…", text)
            log.append(f"removed solution identifier '{ident}'")

    sanitized = re.sub(r"\s+", " ", text).strip()
    usable = sanitized.lower() not in _VAGUE and len(sanitized.split()) >= 4
    return SanitizeResult(sanitized=sanitized, log=log, usable=usable)
