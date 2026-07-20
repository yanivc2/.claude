"""The ONE Decision-B R1/R2 assembly — the single source for BOTH count_tokens and the live run.

The a5/parity rule: there must be exactly one request builder. The frozen count_tokens pass
assembled its 55 requests from these exact pieces (system prompt + sanitized statement + real
allowed source + memory slot + patch/lesson schema; NO public tests inline; NO Anthropic tools).
This module lifts that assembly verbatim so the live canary produces byte-identical requests for
the same inputs. A parity test reconstructs the frozen worst case (max-padded memory, train
variant) through this module and asserts byte-equality, so ``context_cap`` stays valid without
re-counting; the live request (real, smaller memory) is a strict subset that the per-call guard
independently checks is <= context_cap.

Text-only: the request is a single user message (R1) or a 3-turn history (R2). ``tools`` is never
sent; public tests run harness-side and only their sanitized, capped output returns in R2.
"""
from __future__ import annotations

import hashlib
import json
from typing import Optional

from .memory import SLOT_MAX_CHARS, SLOT_MAX_LINES
from .prompt import MEMORY_CLOSE, MEMORY_OPEN

# --- FROZEN template text pieces (verbatim from the count_tokens freeze; hashed for tamper-check) ---
# Decision A/B: a MINIMAL SEARCH/REPLACE patch (output scales with the fix, not the file), a mandatory
# ``### END`` sentinel (so truncation is caught structurally), and — for C-training only — a LESSON
# emitted FIRST (so a truncated file body can never push the lesson past ``max_tokens``).
RESPONSE_SCHEMA = (
    "# Response format\n"
    "Return a MINIMAL patch as SEARCH/REPLACE blocks — do NOT return whole files. Start with a line "
    "'### PATCH'. For each target file you change, write a line '### FILE: <path>' (only the listed "
    "target file(s)), then one or more blocks of EXACTLY:\n"
    "<<<<<<< SEARCH\n"
    "<exact existing lines, copied verbatim, that occur EXACTLY ONCE in the file>\n"
    "=======\n"
    "<replacement lines>\n"
    ">>>>>>> REPLACE\n"
    "Finish the ENTIRE reply with a line '### END'. Do not include tests, prose, or any other file.")
LESSON_SCHEMA = (
    "# Lesson (first)\n"
    "BEFORE the patch, output a line '### LESSON' then a JSON object "
    '{"recommended_action": [..], "avoid": [..]} — a general reusable rule with NO paths, line '
    "numbers, literals, code, or test answers. Then output the patch and the final '### END'.\n")
REPAIR_INSTRUCTION = (
    "# Repair round\nThe public test suite did not pass; its sanitized output is above. Produce a "
    "corrected SEARCH/REPLACE patch in the same format (end with '### END'). Change ONLY the target "
    "file(s).")

PUBLIC_FEEDBACK_CAP = 2000


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:12]


# frozen-piece hashes (must equal S2_REQUEST_TEMPLATE.frozen.json)
RESPONSE_SCHEMA_HASH = _hash(RESPONSE_SCHEMA)
LESSON_SCHEMA_HASH = _hash(LESSON_SCHEMA)
REPAIR_INSTRUCTION_HASH = _hash(REPAIR_INSTRUCTION)


def render_memory_slot(memory_lines: list[str]) -> str:
    """Wrap the injected memory lines in the fixed <memory>…</memory> block (same for all conditions)."""
    return "\n".join([MEMORY_OPEN, *memory_lines, MEMORY_CLOSE])


def max_memory_payload() -> str:
    """The worst-case (fully padded) memory slot used to set context_cap — verbatim from the freeze."""
    line = "- " + ("m" * (SLOT_MAX_CHARS - 2))
    return render_memory_slot([line for _ in range(SLOT_MAX_LINES)])


def build_r1_user_prompt(statement: str, source: dict[str, str], memory_lines: list[str], *,
                         train: bool) -> str:
    """Assemble the R1 user message. ``train`` adds the candidate-lesson schema (C-training worst)."""
    parts = ["# Bug report", statement, "", "# Target source files (edit ONLY these)"]
    for path in sorted(source):
        parts.append(f"## {path}\n```python\n{source[path]}\n```")
    parts.append("")
    parts.append(render_memory_slot(memory_lines))
    parts.append("")
    parts.append((LESSON_SCHEMA if train else "") + RESPONSE_SCHEMA)   # LESSON-first for C-training
    return "\n".join(parts)


def build_r1_worstcase_prompt(statement: str, source: dict[str, str], *, train: bool = True) -> str:
    """Reconstruct the EXACT request the counter measured (max-padded memory) — for the parity proof."""
    line = "- " + ("m" * (SLOT_MAX_CHARS - 2))
    return build_r1_user_prompt(statement, source, [line for _ in range(SLOT_MAX_LINES)], train=train)


def _diverse_line(k: int) -> str:
    """One varied, non-repeating source-ish line so BPE cannot collapse it (the ``"O"*N`` failure)."""
    return (f"acc_{k} = fold_{k}(state_{k}, {(k * 7) % 97}) + norm_{k}(delta_{k}, {(k * 13) % 101})"
            f"  # step {k}: reconcile branch {k % 17}")


def _lesson_json(pad_to: int = 0) -> str:
    """A schema-valid candidate lesson; optionally padded (still valid) toward ``MAX_LESSON_CHARS``."""
    rec = [f"generalize the fold-{i} invariant across the family" for i in range(3)]
    avoid = [f"do not hardcode the step-{i} literal or path" for i in range(2)]
    obj = {"recommended_action": rec, "avoid": avoid}
    s = json.dumps(obj)
    if pad_to and len(s) < pad_to:
        # grow the last recommended_action with diverse words until near the cap (stays valid JSON)
        extra = []
        k = 0
        while len(json.dumps({"recommended_action": rec + [" ".join(extra)], "avoid": avoid})) < pad_to:
            k += 1
            extra.append(f"note{k}")
        obj = {"recommended_action": rec + [" ".join(extra)], "avoid": avoid}
        s = json.dumps(obj)
    return s


def max_r1_assistant_envelope(allowed_source_files: list[str], *, train: bool, units: int,
                              lines_per_block: int = 1, lesson_pad: int = 0) -> str:
    """A deterministic, non-degenerate, PARSER-VALID stand-in for the Round-1 assistant output that
    returns as INPUT inside the worst-case Round-2 request (used to derive ``context_cap``).

    It is NOT the real fix — it is a conservative INPUT envelope in the FROZEN SEARCH/REPLACE schema
    (### LESSON first when ``train``, then ### PATCH with one ``### FILE`` per allowed path carrying
    ``units`` SEARCH/REPLACE blocks, then ``### END``). Properties:

      * parser-valid under ``response_parser.parse_model_response`` (train ⇒ a valid LESSON first);
      * uses ONLY the task's ``allowed_source_files`` — never a fixed source / reference patch;
      * varied content (numbered identifiers) so BPE cannot collapse it below its true token size;
      * a pure function of the args — no randomness, no network — so the frozen envelope reproduces
        byte-for-byte. The gate runner picks the SMALLEST ``units`` whose R2 token delta hits the floor.
    """
    paths = sorted(allowed_source_files)
    if not paths:
        raise ValueError("allowed_source_files is empty — cannot build a scoped envelope")
    per = [units // len(paths)] * len(paths)
    for i in range(units % len(paths)):
        per[i] += 1
    k = 0
    out: list[str] = []
    if train:
        out.append("### LESSON")
        out.append(_lesson_json(lesson_pad))
    out.append("### PATCH")
    for pi, path in enumerate(paths):
        if per[pi] == 0:
            continue
        out.append(f"### FILE: {path}")
        for _ in range(per[pi]):
            search = "\n".join(_diverse_line(k + j) for j in range(1, lines_per_block + 1))
            k += lines_per_block
            replace = "\n".join(_diverse_line(k + j) for j in range(1, lines_per_block + 1))
            k += lines_per_block
            out.extend(["<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE"])
    out.append("### END")
    return "\n".join(out)


def cap_filling_worst_envelope(allowed_source_files: list[str], *, train: bool = True) -> str:
    """The WORST schema-legal visible R1 output: a LESSON padded toward ``MAX_LESSON_CHARS`` plus a
    patch that fills the frozen caps (blocks × chars) WITHOUT exceeding them. Measured via count_tokens
    to CALIBRATE ``max_tokens`` (Decision B: caps drive max_tokens, never the budget). Must stay
    parser-valid (a negative test would reject it if it tripped a cap)."""
    from . import patch_format as PF
    # fill the frozen caps: use the max block count and grow lines-per-side until the total patch
    # chars approach MAX_TOTAL_PATCH_CHARS (≤ cap), respecting the per-block char caps. Each diverse
    # line ≈ 95-130 chars. Deterministic — a pure function of the caps.
    blocks = PF.MAX_PATCH_BLOCKS
    line_chars = len(_diverse_line(10 ** 6))                      # conservative (large-k) line length
    per_side_cap = min(PF.MAX_BLOCK_SEARCH_CHARS, PF.MAX_BLOCK_REPLACE_CHARS) // line_chars
    lines_per_side = 1
    while True:
        cand = lines_per_side + 1
        est_total = blocks * 2 * cand * line_chars
        if cand > per_side_cap or est_total > PF.MAX_TOTAL_PATCH_CHARS - line_chars:
            break
        lines_per_side = cand
    return max_r1_assistant_envelope(allowed_source_files, train=train, units=blocks,
                                     lines_per_block=lines_per_side, lesson_pad=PF.MAX_LESSON_CHARS - 50)


def build_r2_messages(r1_user_prompt: str, assistant_text: str, public_feedback: str, *,
                      cap: int = PUBLIC_FEEDBACK_CAP) -> list[dict]:
    """The 3-turn R2 history: [user R1] + [assistant round-1 patch] + [user capped feedback + repair]."""
    fb = (public_feedback or "")[:cap]
    return [
        {"role": "user", "content": r1_user_prompt},
        {"role": "assistant", "content": assistant_text},
        {"role": "user", "content": fb + "\n" + REPAIR_INSTRUCTION},
    ]


def frozen_pieces_snapshot() -> dict:
    """The live frozen prompt pieces + patch-format caps (single source for the request-template
    hash and the Gate-1 artifact). A drift in any of these is tamper-evident downstream."""
    from . import patch_format as PF
    return {"response_schema_hash": RESPONSE_SCHEMA_HASH,
            "lesson_schema_hash": LESSON_SCHEMA_HASH,
            "repair_instruction_hash": REPAIR_INSTRUCTION_HASH,
            "public_feedback_cap": PUBLIC_FEEDBACK_CAP,
            "memory_slot_limits": {"lines": SLOT_MAX_LINES, "chars": SLOT_MAX_CHARS},
            "patch_caps": PF.caps_snapshot()}


def assert_frozen_pieces_match(template: dict) -> None:
    """Block if the live pieces drifted from the frozen priced template (single-source guarantee)."""
    from .gates import GateError
    for k, v in frozen_pieces_snapshot().items():
        if template.get(k) != v:
            raise GateError(f"live prompt piece {k!r} != frozen template ({template.get(k)!r} != {v!r})")
