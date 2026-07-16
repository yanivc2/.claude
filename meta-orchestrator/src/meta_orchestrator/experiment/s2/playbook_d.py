"""Condition-D authoring infrastructure — schema, blind validator, freeze (NO content here).

Claude Code does NOT write D. An independent author (human or another model) receives only
``corpus/D_AUTHOR_PACKET.md`` — the blind spec — and returns a ``DSubmission``. This module:

  * defines the hard D schema (trigger_or_context / recommended_action / avoid / verification_step);
  * validates a submission — schema, size, and a leak scan that rejects task ids, code, paths,
    patches, test answers, or any bug-specific detail the author must never have seen;
  * renders D into the SAME bullet shape and the SAME slot budget as C (no text/format edge);
  * freezes a clean submission into a ``StaticPlaybook`` with ``author_frozen=True`` and a
    content hash — after which the immutable model blocks any field change.

There is intentionally no real advice in this file; the tests use a generic fixture submission
only to exercise the validator, never as the experiment's D.
"""
from __future__ import annotations

import hashlib
import json
import re

from pydantic import BaseModel, Field

from ..lesson import _FORBIDDEN
from .memory import SLOT_MAX_CHARS, SLOT_MAX_LINES, StaticPlaybook

# --- size caps (shared spirit with C's slot budget; the render budget is the hard gate) ----
MAX_ENTRIES_PER_FAMILY = 2
MAX_ACTIONS = 3
MAX_AVOID = 3
MAX_FIELD_CHARS = SLOT_MAX_CHARS

# Bug/corpus identifiers the author must never reference (project-<number>).
_TASK_ID_RE = re.compile(r"\b(black|cookiecutter|discord\.py|poetry|scrapy|freqtrade)[-_\s]?\d+\b",
                         re.IGNORECASE)


class PlaybookEntry(BaseModel):
    trigger_or_context: str
    recommended_action: list[str] = Field(default_factory=list)
    avoid: list[str] = Field(default_factory=list)
    verification_step: str = ""


class DSubmission(BaseModel):
    author: str
    author_type: str                      # "human" | "model:<id>" — provenance, recorded on freeze
    families: dict[str, list[PlaybookEntry]] = Field(default_factory=dict)


class DValidationError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def _render_family(entries: list[PlaybookEntry]) -> list[str]:
    """Same bullet style as C's lessons: actions, a verify line, then avoids (trigger not shown)."""
    lines: list[str] = []
    for e in entries:
        lines.extend(e.recommended_action)
        if e.verification_step:
            lines.append(f"verify: {e.verification_step}")
        lines.extend(f"avoid: {a}" for a in e.avoid)
    return lines


def _leaks(text: str) -> list[str]:
    hits: list[str] = []
    if _TASK_ID_RE.search(text):
        hits.append("task/corpus id")
    for pat, why in _FORBIDDEN:               # paths, code, patches, assert/return, concrete values
        if re.search(pat, text):
            hits.append(why)
    return hits


def validate_d_submission(sub: DSubmission, present_families: list[str]) -> list[str]:
    """Return a list of problems (empty == clean). Blind: no corpus/model input is consulted."""
    errors: list[str] = []
    present = set(present_families)

    unknown = sorted(set(sub.families) - present)
    if unknown:
        errors.append(f"advice for unknown/absent families: {unknown}")
    missing = sorted(f for f in present if not sub.families.get(f))
    if missing:
        errors.append(f"missing advice for present families: {missing}")

    for fam, entries in sub.families.items():
        if len(entries) > MAX_ENTRIES_PER_FAMILY:
            errors.append(f"{fam}: {len(entries)} entries > {MAX_ENTRIES_PER_FAMILY}")
        for i, e in enumerate(entries):
            if len(e.recommended_action) > MAX_ACTIONS:
                errors.append(f"{fam}[{i}]: {len(e.recommended_action)} actions > {MAX_ACTIONS}")
            if len(e.avoid) > MAX_AVOID:
                errors.append(f"{fam}[{i}]: {len(e.avoid)} avoid > {MAX_AVOID}")
            if not e.recommended_action:
                errors.append(f"{fam}[{i}]: no recommended_action")
            fields = [("trigger_or_context", e.trigger_or_context),
                      ("verification_step", e.verification_step),
                      *[("recommended_action", a) for a in e.recommended_action],
                      *[("avoid", a) for a in e.avoid]]
            for name, text in fields:
                if len(text) > MAX_FIELD_CHARS:
                    errors.append(f"{fam}[{i}].{name}: {len(text)} chars > {MAX_FIELD_CHARS}")
                for hit in _leaks(text):
                    errors.append(f"{fam}[{i}].{name}: LEAK ({hit})")
        rendered = _render_family(entries)
        if len(rendered) > SLOT_MAX_LINES:
            errors.append(f"{fam}: rendered {len(rendered)} lines > slot budget {SLOT_MAX_LINES}")
    return errors


def submission_hash(sub: DSubmission) -> str:
    blob = json.dumps(sub.model_dump(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


def freeze_d(sub: DSubmission, present_families: list[str]) -> StaticPlaybook:
    """Validate then freeze into an immutable, author-frozen StaticPlaybook. Raises on any issue."""
    errors = validate_d_submission(sub, present_families)
    if errors:
        raise DValidationError(errors)
    by_family = {fam: _render_family(entries) for fam, entries in sub.families.items()}
    return StaticPlaybook(by_family=by_family, author_frozen=True,
                          author=f"{sub.author_type}:{sub.author}")
