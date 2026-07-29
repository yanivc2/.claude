"""Condition-D authoring infrastructure — schema, blind validator, freeze (NO content here).

Claude Code does NOT write D. An independent author (human or another model) receives only
``corpus/D_AUTHOR_PACKET.md`` — the blind spec — and returns a ``DSubmission``. This module:

  * defines the hard D schema — `trigger_or_context` (source-only, never injected),
    `recommended_action`, `avoid`; any verification advice is folded into recommended_action;
  * validates a submission — schema, size, and a leak scan that rejects task ids, code, paths,
    patches, test answers, or any bug-specific detail the author must never have seen;
  * renders D into the SAME injected shape as C — actions + avoid — under the same slot budget,
    so D gets no text/format edge (no extra "verify" line, no richer structure);
  * freezes a clean submission into a ``StaticPlaybook`` with ``author_frozen=True`` and a
    content hash — after which the immutable model blocks any field change.

There is intentionally no real advice in this file; the tests use a generic fixture submission
only to exercise the validator, never as the experiment's D.
"""
from __future__ import annotations

import hashlib
import json
import re

from pydantic import BaseModel, ConfigDict, Field

from ..lesson import _FORBIDDEN, _find_path_leak
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
    # Author-facing wire shape (one advice entry, tagged by family). `trigger_or_context` is
    # SOURCE-ONLY — it is NEVER injected (mirroring how condition C's trigger is not injected).
    # The injected shape is exactly C's: recommended_action + avoid. Any verification advice must
    # be folded INTO recommended_action, so D gets no richer format.
    # extra="forbid": an unknown field (e.g. a stray verification_step) is rejected, not dropped.
    model_config = ConfigDict(extra="forbid")

    family: str
    trigger_or_context: str
    recommended_action: list[str] = Field(default_factory=list)
    avoid: list[str] = Field(default_factory=list)


class DSubmission(BaseModel):
    """The author returns exactly this — schema-only, no reasoning/prose. Metadata (author_type,
    author_name) is kept OUT of the injected content so it never spends the slot budget."""

    model_config = ConfigDict(extra="forbid")

    author_type: str                      # "external_model" | "external_human" | "other_claude"
    author_name: str                      # provenance only — never injected
    entries: list[PlaybookEntry] = Field(default_factory=list)

    def by_family(self) -> dict[str, list[PlaybookEntry]]:
        grouped: dict[str, list[PlaybookEntry]] = {}
        for e in self.entries:
            grouped.setdefault(e.family, []).append(e)
        return grouped


class DValidationError(ValueError):
    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def _render_family(entries: list[PlaybookEntry]) -> list[str]:
    """IDENTICAL bullet shape to C's lessons: actions, then avoids. Trigger is never shown."""
    lines: list[str] = []
    for e in entries:
        lines.extend(e.recommended_action)
        lines.extend(f"avoid: {a}" for a in e.avoid)
    return lines


def _leaks(text: str) -> list[str]:
    hits: list[str] = []
    if _TASK_ID_RE.search(text):
        hits.append("task/corpus id")
    for pat, why in _FORBIDDEN:               # code, patches, assert/return, concrete values, line #
        if re.search(pat, text):
            hits.append(why)
    path_why = _find_path_leak(text)          # path-aware (C/D share one leak standard): a real
    if path_why:                              # filesystem path leaks, a lone slash-joined pair does not
        hits.append(path_why)
    return hits


def validate_d_submission(sub: DSubmission, present_families: list[str]) -> list[str]:
    """Return a list of TECHNICAL schema problems (empty == clean). Blind: consults no corpus,
    no model, no per-bug data. Messages are schema/structure only — never a content hint."""
    errors: list[str] = []
    present = set(present_families)
    grouped = sub.by_family()

    if not sub.author_type.strip() or not sub.author_name.strip():
        errors.append("author_type and author_name are required")
    unknown = sorted(set(grouped) - present)
    if unknown:
        errors.append(f"advice for unknown/absent families: {unknown}")
    missing = sorted(f for f in present if not grouped.get(f))
    if missing:
        errors.append(f"missing advice for present families: {missing}")

    for fam, entries in grouped.items():
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
    """Validate then freeze into an immutable, author-frozen StaticPlaybook. Raises on any issue.

    Author metadata is recorded on the StaticPlaybook but is NOT part of by_family (the injected
    content) — so provenance never spends the slot budget or leaks into the agent's prompt.
    """
    errors = validate_d_submission(sub, present_families)
    if errors:
        raise DValidationError(errors)
    by_family = {fam: _render_family(entries) for fam, entries in sub.by_family().items()}
    return StaticPlaybook(by_family=by_family, author_frozen=True,
                          author=f"{sub.author_type}:{sub.author_name}")
