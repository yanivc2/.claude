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
RESPONSE_SCHEMA = (
    "# Response format\n"
    "Return the COMPLETE corrected contents of each target file, each as a fenced ```python block "
    "preceded by a line '### FILE: <path>'. Change ONLY the listed target file(s). Do not include "
    "tests, prose, or any other file.")
LESSON_SCHEMA = (
    "\nAfter the file block(s), append one line '### LESSON' then a JSON object "
    '{"recommended_action": [..], "avoid": [..]} — a general reusable rule with NO paths, line '
    "numbers, literals, code, or test answers.")
REPAIR_INSTRUCTION = (
    "# Repair round\nThe public test suite did not pass; its sanitized output is above. Produce a "
    "corrected version of the target file(s) in the same format. Change ONLY the target file(s).")

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
    parts.append(RESPONSE_SCHEMA + (LESSON_SCHEMA if train else ""))
    return "\n".join(parts)


def build_r1_worstcase_prompt(statement: str, source: dict[str, str], *, train: bool = True) -> str:
    """Reconstruct the EXACT request the counter measured (max-padded memory) — for the parity proof."""
    line = "- " + ("m" * (SLOT_MAX_CHARS - 2))
    return build_r1_user_prompt(statement, source, [line for _ in range(SLOT_MAX_LINES)], train=train)


def max_r1_assistant_envelope(allowed_source_files: list[str], *, train: bool, units: int) -> str:
    """A CONSERVATIVE, deterministic, non-degenerate stand-in for the Round-1 assistant output that
    returns as INPUT inside the worst-case Round-2 request (used to derive ``context_cap``).

    It is NOT the real fix and NOT a claim about what the model can emit in 4096 output tokens — it
    is a conservative INPUT envelope (see ``conservative_r1_assistant_input_envelope`` in the gate
    runner). Properties enforced here so the runner's delta measurement is meaningful:

      * parser-valid under ``response_parser.parse_model_response`` (one FILE block per allowed
        path; a LESSON block when ``train``);
      * uses ONLY the task's ``allowed_source_files`` — never a fixed source / reference patch;
      * varied, non-repeating content (numbered identifiers + changing literals) so BPE cannot
        collapse it into far fewer tokens than its size (the failure mode of ``"O"*N`` filler);
      * a pure function of (paths, train, units) — no randomness, no network — so the frozen
        envelope reproduces byte-for-byte. The runner picks the SMALLEST ``units`` whose measured
        R2 token delta reaches the floor.
    """
    paths = sorted(allowed_source_files)
    if not paths:
        raise ValueError("allowed_source_files is empty — cannot build a scoped envelope")
    per = [units // len(paths)] * len(paths)
    for i in range(units % len(paths)):
        per[i] += 1
    blocks: list[str] = []
    k = 0
    for pi, path in enumerate(paths):
        # one diverse line per unit → fine granularity so the runner can land the R2 delta close to
        # the floor (small overshoot). Numbers/identifiers change every line so BPE cannot collapse it.
        lines = ["# conservative R1-output envelope — synthetic, non-degenerate; NOT the real fix"]
        for _ in range(per[pi]):
            k += 1
            lines.append(f"acc_{k} = fold_{k}(state_{k}, {(k * 7) % 97}) + norm_{k}(delta_{k}, "
                         f"{(k * 13) % 101})  # step {k}: reconcile branch {k % 17}")
        blocks.append(f"### FILE: {path}\n```python\n" + "\n".join(lines) + "\n```")
    text = "\n".join(blocks)
    if train:                                          # C-training worst case carries a lesson too
        lesson = {"recommended_action": [f"generalize the fold-{i} invariant" for i in range(3)],
                  "avoid": [f"do not hardcode the step-{i} literal" for i in range(2)]}
        text += "\n### LESSON\n" + json.dumps(lesson)
    return text


def build_r2_messages(r1_user_prompt: str, assistant_text: str, public_feedback: str, *,
                      cap: int = PUBLIC_FEEDBACK_CAP) -> list[dict]:
    """The 3-turn R2 history: [user R1] + [assistant round-1 patch] + [user capped feedback + repair]."""
    fb = (public_feedback or "")[:cap]
    return [
        {"role": "user", "content": r1_user_prompt},
        {"role": "assistant", "content": assistant_text},
        {"role": "user", "content": fb + "\n" + REPAIR_INSTRUCTION},
    ]


def assert_frozen_pieces_match(template: dict) -> None:
    """Block if the live pieces drifted from the frozen priced template (single-source guarantee)."""
    from .gates import GateError
    checks = {"response_schema_hash": RESPONSE_SCHEMA_HASH,
              "lesson_schema_hash": LESSON_SCHEMA_HASH,
              "repair_instruction_hash": REPAIR_INSTRUCTION_HASH,
              "public_feedback_cap": PUBLIC_FEEDBACK_CAP,
              "memory_slot_limits": {"lines": SLOT_MAX_LINES, "chars": SLOT_MAX_CHARS}}
    for k, v in checks.items():
        if template.get(k) != v:
            raise GateError(f"live prompt piece {k!r} != frozen template ({template.get(k)!r} != {v!r})")
