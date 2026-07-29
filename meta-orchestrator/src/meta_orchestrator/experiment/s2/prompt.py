"""Deterministic agent-prompt assembler for the PAID run + whole-request parity helpers (P0.3/D).

Two distinct renderings of the memory slot exist, on purpose:
  * ``render_lines`` (memory.py) emits an ``@@MEM kind=… family=…`` tag — this is a TEST-DOUBLE
    affordance so the offline routing mock can verify WHICH family arrived. It must never reach a
    real model: ``kind=other_family`` / ``static_playbook`` would literally tell the model "this is
    a placebo / a static playbook", a condition label = a confound.
  * ``render_memory_payload`` here emits ONLY the label-free advice bullets the model should see.

The real held-out prompt is therefore identical across A/C/D/B1 except for the bytes inside the
``<memory>…</memory>`` region — and carries no family name, condition name, or placebo hint.
``mask_memory_region`` blanks that region so a test can assert byte-identical requests.
"""
from __future__ import annotations

import re

from .memory import SLOT_MAX_CHARS, SLOT_MAX_LINES, MemoryContext

MEMORY_OPEN = "<memory>"
MEMORY_CLOSE = "</memory>"
_MASK = f"{MEMORY_OPEN}<masked>{MEMORY_CLOSE}"
_REGION = re.compile(re.escape(MEMORY_OPEN) + ".*?" + re.escape(MEMORY_CLOSE), re.DOTALL)


def render_memory_payload(mc: MemoryContext) -> list[str]:
    """The label-free bullets the REAL model sees — same cap as render_lines, but NO kind tag."""
    capped = [ln[:SLOT_MAX_CHARS] for ln in mc.lines[:SLOT_MAX_LINES]]
    return [f"- {ln}" for ln in capped]


def build_agent_prompt(
    *,
    source: dict[str, str],
    public_tests: dict[str, str],
    memory_payload: list[str],
    public_feedback: str | None = None,
) -> str:
    """Assemble the user prompt deterministically. The memory region is always present (empty for
    the no-memory baseline) and is the ONLY place conditions may differ. No family/condition label.
    """
    parts: list[str] = ["# Task",
                        "Repair the given source file(s) so the public test suite passes. "
                        "Modify only the given source file(s); do not edit tests or evaluation logic.",
                        "# Source files"]
    for path in sorted(source):
        parts.append(f"## {path}\n{source[path]}")
    parts.append("# Public tests")
    for path in sorted(public_tests):
        parts.append(f"## {path}\n{public_tests[path]}")
    parts.append(MEMORY_OPEN)
    parts.extend(memory_payload)                    # empty list for condition A
    parts.append(MEMORY_CLOSE)
    if public_feedback:
        parts.append("# Previous public test output")
        parts.append(public_feedback)
    return "\n".join(parts)


def mask_memory_region(prompt: str) -> str:
    """Blank the memory region so two prompts can be compared for everything-but-memory equality."""
    return _REGION.sub(_MASK, prompt)


def prompt_carries_condition_label(prompt: str) -> bool:
    """True if a condition/placebo/family-routing label leaked into the prompt (must be False)."""
    banned = ("@@MEM", "kind=", "family_relevant", "other_family", "static_playbook",
              "placebo", "condition C", "condition B1")
    return any(tok in prompt for tok in banned)
