"""Parse the model's declarative response (Decision A/B: LESSON-first, then a minimal SEARCH/REPLACE
patch, then a mandatory ``### END`` sentinel).

Strict and non-creative: the parser accepts ONLY the frozen schema, rejects any path outside
``allowed_source_files``, never "fixes" a malformed reply, and separates the candidate lesson from
the patch. It is STRUCTURAL only — it does not touch the source; exact-match / uniqueness / overlap
are the applier's job (``realtask.apply_patch`` → ``patch_format.apply_search_replace``).

Frozen response layout:

    ### LESSON              (C-training ONLY — must come BEFORE the patch)
    {"recommended_action": [...], "avoid": [...]}
    ### PATCH
    ### FILE: <allowed path>
    <<<<<<< SEARCH
    <exact existing text>
    =======
    <replacement text>
    >>>>>>> REPLACE
    ### END                 (mandatory sentinel — its ABSENCE means the output was truncated)

The mandatory ``### END`` sentinel + ``stop_reason`` are how truncation is caught structurally instead
of being silently accepted (the black-112 canary defect). A truncated or malformed reply is a SOLVER
outcome (no valid patch → the public suite fails), never an infrastructure error and never a retry.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Optional

from pydantic import BaseModel, Field

from ..lesson import Lesson
from . import patch_format as PF

# A SINGLE outer markdown fence wrapping the ENTIRE field, with only whitespace outside it and no
# nested fence inside. Stripping it is FRAMING normalization (LLMs commonly fence JSON / code blocks),
# NOT semantic repair: after stripping, the strict parser/json.loads runs unchanged. Anything else
# (prose around the field, multiple fences, a partial fence) is left as-is → it fails the strict parse.
_OUTER_FENCE_RE = re.compile(r"\A\s*```[^\n]*\n(?P<body>.*)\n```\s*\Z", re.DOTALL)


def _strip_single_outer_fence(text: str) -> str:
    """Remove exactly one outer ```…``` fence that wraps the whole field (whitespace-only outside,
    no nested fence). Otherwise return ``text`` unchanged — never extract a fenced fragment out of
    surrounding prose."""
    m = _OUTER_FENCE_RE.match(text)
    if not m:
        return text
    body = m.group("body")
    if re.search(r"^\s*```", body, re.MULTILINE):      # nested fence → not a single clean wrapper
        return text
    return body


class ParsedResponse(BaseModel):
    # path -> list of (search, replace); empty ⇒ no valid patch (parse failure)
    edits: dict[str, list[tuple[str, str]]] = Field(default_factory=dict)
    candidate_lesson: Optional[Lesson] = None
    ok: bool
    reason: str = ""                       # "ok" or a frozen taxonomy code
    end_marker_present: bool = False
    files_touched: int = 0
    total_blocks: int = 0


def _find_marker_line(lines: list[str], marker: str) -> int:
    for idx, ln in enumerate(lines):
        if ln == marker:
            return idx
    return -1


def parse_model_response(text: str, *, allowed_source_files: list[str], task_family: str,
                         is_train: bool) -> ParsedResponse:
    """Deterministically parse ``text``. Never raises on bad content — returns ok=False + a code."""
    lines = (text or "").split("\n")
    end_idx = _find_marker_line(lines, PF.END_MARK)
    end_present = end_idx != -1
    patch_idx = _find_marker_line(lines, PF.PATCH_MARK)
    lesson_idx = _find_marker_line(lines, PF.LESSON_MARK)

    def fail(reason: str) -> ParsedResponse:
        return ParsedResponse(ok=False, reason=reason, end_marker_present=end_present)

    if not end_present:                                   # structural truncation signal
        return fail("missing_end")
    if patch_idx == -1:
        return fail("no_patch_section")
    if patch_idx > end_idx:
        return fail(PF.SCHEMA_INVALID + ":patch_after_end")

    # --- lesson (C-training only; must precede the patch) ---
    lesson: Optional[Lesson] = None
    if is_train:
        if lesson_idx == -1:
            return fail("missing_lesson")
        if lesson_idx > patch_idx:
            return fail(PF.SCHEMA_INVALID + ":lesson_after_patch")
        lesson_json = _strip_single_outer_fence("\n".join(lines[lesson_idx + 1:patch_idx]).strip())
        if len(lesson_json) > PF.MAX_LESSON_CHARS:
            return fail(PF.LIMIT_EXCEEDED + ":lesson_chars")
        lesson = _parse_lesson(lesson_json, task_family)
        if lesson is None:
            return fail("malformed_lesson")
    elif lesson_idx != -1:                                # non-train must NOT propose a lesson
        return fail(PF.SCHEMA_INVALID + ":unexpected_lesson")

    # --- patch region (between ### PATCH and ### END); tolerate one outer fence around the body ---
    region = _strip_single_outer_fence("\n".join(lines[patch_idx + 1:end_idx]))
    try:
        parsed = PF.parse_patch_region(region, allowed_source_files)
    except PF.PatchFormatError as exc:
        return fail(exc.code + (f":{exc.detail}" if exc.detail else ""))

    edits = {path: [(sr.search, sr.replace) for sr in blocks] for path, blocks in parsed}
    total_blocks = sum(len(b) for b in edits.values())
    return ParsedResponse(edits=edits, candidate_lesson=lesson, ok=True, reason="ok",
                          end_marker_present=True, files_touched=len(edits), total_blocks=total_blocks)


def _parse_lesson(raw_json: str, task_family: str) -> Optional[Lesson]:
    """Build a CANDIDATE lesson from the model's JSON. Leak/schema screening is the write-gate's job."""
    try:
        obj = json.loads(raw_json)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    rec = obj.get("recommended_action") or []
    avoid = obj.get("avoid") or []
    if not isinstance(rec, list) or not isinstance(avoid, list):
        return None
    rec = [str(x) for x in rec]
    avoid = [str(x) for x in avoid]
    lid = "cand-" + hashlib.sha256(
        json.dumps({"f": task_family, "r": rec, "a": avoid}, sort_keys=True).encode()
    ).hexdigest()[:10]
    return Lesson(lesson_id=lid, task_family=task_family, recommended_action=rec, avoid=avoid,
                  status="candidate")
