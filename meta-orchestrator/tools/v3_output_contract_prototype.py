"""v3 output-contract prototype ($0, offline) — robust structured-edit parser + applier.

The v2.2 pilot's dominant failure was the output contract: 19/32 primary cells produced no valid
applied patch (15 malformed SEARCH/REPLACE + 4 exact-anchor apply failures). This prototype
implements the recommended v3 contract — a JSON list of UNIQUE-ANCHOR edits with an explicit
completion sentinel — and proves offline that its PARSER + APPLIER are deterministic and
fail-closed: 0% ambiguous application, 0% silent partial application, truncation detectable,
100% deterministic replay. (Whether the model EMITS this format reliably is a model-side
question answered only by a paid v3 micro-pilot; this file settles the harness-side half.)

Contract (what the model must emit):
    {"edits": [{"anchor": "<substring occurring EXACTLY ONCE in the target file>",
                "replacement": "<text that replaces the anchor>"}, ...],
     "done": true}
A single ```json ... ``` fence is tolerated. `done` must be literally true (its absence ⇒ the
output was truncated). Anchors are short unique signatures, NOT verbatim multi-line blocks that
must match whitespace-exactly — that exact-block requirement is what caused v2.2 apply failures.
"""
from __future__ import annotations

import json
import re
from typing import Optional

# terminal states (parallel to the apparatus taxonomy)
OK = "OK"
MALFORMED = "MALFORMED"
TRUNCATED = "TRUNCATED"
APPLY_NOT_FOUND = "APPLY_NOT_FOUND"
AMBIGUOUS = "AMBIGUOUS"
OVERLAP = "OVERLAP"
EMPTY_EDITS = "EMPTY_EDITS"

_FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.DOTALL)


class ContractError(Exception):
    def __init__(self, state: str, detail: str = ""):
        super().__init__(f"{state}: {detail}")
        self.state = state
        self.detail = detail


def parse_edits(text: str) -> dict:
    """Parse the model output into a validated edit document. Fail-closed with a precise state.

    Distinguishes TRUNCATED (unterminated / missing `done`) from MALFORMED (structurally wrong)
    so the harness can decide whether a repair-retry is worthwhile."""
    raw = text if text is not None else ""
    m = _FENCE.match(raw)
    body = m.group(1) if m else raw.strip()
    if not body:
        raise ContractError(TRUNCATED, "empty output")
    try:
        doc = json.loads(body)
    except json.JSONDecodeError as e:
        msg = str(e).lower()
        # an unterminated string/array/object or an error at EOF is the fingerprint of truncation.
        truncated = ("unterminated" in msg or "expecting" in msg and e.pos >= len(body) - 2)
        raise ContractError(TRUNCATED if truncated else MALFORMED, str(e))
    if not isinstance(doc, dict) or "edits" not in doc:
        raise ContractError(MALFORMED, "top-level object must carry an 'edits' list")
    if doc.get("done") is not True:
        raise ContractError(TRUNCATED, "missing/false completion sentinel 'done': true")
    edits = doc["edits"]
    if not isinstance(edits, list):
        raise ContractError(MALFORMED, "'edits' must be a list")
    norm = []
    for i, ed in enumerate(edits):
        if not isinstance(ed, dict) or "anchor" not in ed or "replacement" not in ed:
            raise ContractError(MALFORMED, f"edit[{i}] must have 'anchor' and 'replacement'")
        if not isinstance(ed["anchor"], str) or not isinstance(ed["replacement"], str):
            raise ContractError(MALFORMED, f"edit[{i}] anchor/replacement must be strings")
        if ed["anchor"] == "":
            raise ContractError(MALFORMED, f"edit[{i}] anchor is empty")
        norm.append({"anchor": ed["anchor"], "replacement": ed["replacement"]})
    return {"edits": norm}


def apply_edits(source: str, edits: list) -> str:
    """Apply edits ALL-OR-NONE. Each anchor must occur EXACTLY ONCE (0→APPLY_NOT_FOUND,
    >1→AMBIGUOUS); spans may not overlap (→OVERLAP). Deterministic (rightmost-first). A validation
    failure raises BEFORE any mutation, so a partial application can never be written."""
    if not edits:
        raise ContractError(EMPTY_EDITS, "no edits proposed (no-op repair)")
    spans = []
    for i, ed in enumerate(edits):
        a = ed["anchor"]
        first = source.find(a)
        if first == -1:
            raise ContractError(APPLY_NOT_FOUND, f"edit[{i}] anchor not found")
        if source.find(a, first + 1) != -1:
            raise ContractError(AMBIGUOUS, f"edit[{i}] anchor occurs more than once")
        spans.append((first, first + len(a), ed["replacement"]))
    spans.sort()
    for (s1, e1, _), (s2, e2, _) in zip(spans, spans[1:]):
        if e1 > s2:
            raise ContractError(OVERLAP, "two edits target overlapping regions")
    out = source
    for start, end, repl in sorted(spans, reverse=True):        # rightmost-first: indices stay valid
        out = out[:start] + repl + out[end:]
    return out


def parse_and_apply(text: str, source: str) -> tuple[str, str]:
    """Return (terminal_state, new_source_or_original). Never raises; never partially applies."""
    try:
        doc = parse_edits(text)
        return OK, apply_edits(source, doc["edits"])
    except ContractError as e:
        return e.state, source


def gate_a_metrics(fixtures: list) -> dict:
    """Offline Gate-A harness-side metrics over (text, source, kind) fixtures where kind is
    'wellformed' (must parse+apply OK) / 'truncated' / 'malformed' / 'ambiguous' / 'apply_fail'.
    silent_partial_rate is 0 by construction (all-or-none) and is verified against the source."""
    total_wf = accepted_wf = 0
    ambiguous_leaks = silent_partial = 0
    for text, source, kind in fixtures:
        state, out = parse_and_apply(text, source)
        if kind == "wellformed":
            total_wf += 1
            if state == OK and out != source:
                accepted_wf += 1
        if kind == "ambiguous" and state == OK:
            ambiguous_leaks += 1                                # an ambiguous edit that got applied
        if state != OK and out != source:
            silent_partial += 1                                 # a non-OK state that still mutated
    return {"wellformed_parser_acceptance": (accepted_wf / total_wf) if total_wf else None,
            "ambiguous_application_rate": ambiguous_leaks,
            "silent_partial_application_events": silent_partial,
            "n_fixtures": len(fixtures)}


if __name__ == "__main__":
    print("v3 output-contract prototype ($0, offline). Import parse_edits/apply_edits/"
          "parse_and_apply; see tests/test_v3_output_contract_prototype.py. NO API calls.")
