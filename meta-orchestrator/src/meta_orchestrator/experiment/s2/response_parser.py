"""Parse the model's declarative response into a patch (+ optional candidate lesson).

Strict and non-creative (Decision B): the parser accepts ONLY the frozen schema, rejects any path
outside ``allowed_source_files``, never "fixes" a malformed reply, and separates the patch from the
candidate lesson. A response that cannot be parsed is a SOLVER failure (empty patch → the public
suite will fail), NOT an infrastructure error and NOT a retry — so a model that emits garbage is a
valid experimental outcome, exactly as pre-registered.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Optional

from pydantic import BaseModel

from ..lesson import Lesson

_FILE_BLOCK = re.compile(
    r"^###[ \t]*FILE:[ \t]*(?P<path>.+?)[ \t]*\n```(?:python)?\n(?P<body>.*?)\n```",
    re.MULTILINE | re.DOTALL)
_LESSON = re.compile(r"^###[ \t]*LESSON[ \t]*\n(?P<json>\{.*\})", re.MULTILINE | re.DOTALL)


class ParsedResponse(BaseModel):
    patch: dict[str, str]                       # path -> new content (empty ⇒ parse failure)
    candidate_lesson: Optional[Lesson] = None
    ok: bool
    reason: str = ""


def parse_model_response(text: str, *, allowed_source_files: list[str], task_family: str,
                         is_train: bool) -> ParsedResponse:
    """Deterministically parse ``text``. Never raises on bad content — returns ok=False instead."""
    allowed = set(allowed_source_files)
    patch: dict[str, str] = {}
    for m in _FILE_BLOCK.finditer(text or ""):
        path = m.group("path").strip()
        if path not in allowed:                 # out-of-scope path — reject the whole block set
            return ParsedResponse(patch={}, ok=False, reason=f"path_not_allowed:{path}")
        if path in patch:
            return ParsedResponse(patch={}, ok=False, reason=f"duplicate_file_block:{path}")
        patch[path] = m.group("body")
    if not patch:
        return ParsedResponse(patch={}, ok=False, reason="no_valid_file_block")

    lesson: Optional[Lesson] = None
    if is_train:
        lm = _LESSON.search(text or "")
        if lm:
            lesson = _parse_lesson(lm.group("json"), task_family)   # may be None on bad JSON/schema
    return ParsedResponse(patch=patch, candidate_lesson=lesson, ok=True, reason="ok")


def _parse_lesson(raw_json: str, task_family: str) -> Optional[Lesson]:
    """Build a CANDIDATE lesson from the model's JSON. Leak/schema screening is the write-gate's job."""
    try:
        obj = json.loads(raw_json)
    except Exception:
        return None                              # unparseable lesson ⇒ no candidate (patch still stands)
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
