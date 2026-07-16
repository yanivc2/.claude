"""The memory component — the ONLY thing that differs across A / C / D / B1 (Decision B, C).

All four conditions share the same task, contract, tools, verifier, prompt order, and
context ceiling. They differ solely in what (if anything) is injected at the fixed memory
slot:

  A   → nothing                       (no-memory baseline)
  C   → this task's own family lessons (learned + frozen)
  B1  → another family's lessons      (relevance placebo — hash-locked mis-routing)
  D   → a static hand-written playbook (no learning)

B1 reuses C's *own* bank objects, just keyed to a different family, so text length /
schema / quality are identical by construction and only *relevance* varies. Rendering is
byte-identical in shape across C/B1/D (same tag line + bulleted lines); only the content
differs. That is what neutralises the "any extra text helps" confound.
"""
from __future__ import annotations

import hashlib
import json
from typing import Optional

from pydantic import BaseModel, Field

from ..lesson import Lesson
from .families import SEMANTIC_FAMILIES

CONDITIONS = ["A", "C", "D", "B1"]

# component_kind values — the machine-readable label of the injected slot.
KIND_NONE = "none"
KIND_FAMILY_RELEVANT = "family_relevant"    # C
KIND_OTHER_FAMILY = "other_family"          # B1
KIND_STATIC_PLAYBOOK = "static_playbook"    # D


class MemoryFrozenError(RuntimeError):
    """A write was attempted against a frozen (held-out phase) lesson bank."""


class FrozenLessonBank(BaseModel):
    """Per-fold, learned-then-frozen lessons grouped by family. Immutable during held-out."""

    by_family: dict[str, list[Lesson]] = Field(default_factory=dict)
    frozen: bool = True

    def lessons_for(self, family: str) -> list[Lesson]:
        return list(self.by_family.get(family, []))

    def families_present(self) -> list[str]:
        return sorted(f for f, ls in self.by_family.items() if ls)

    def add(self, family: str, lesson: Lesson) -> None:
        # Held-out evaluation must never mutate memory (Decision D). A frozen bank refuses.
        if self.frozen:
            raise MemoryFrozenError("cannot write to a frozen lesson bank during held-out")
        self.by_family.setdefault(family, []).append(lesson)

    def content_hash(self) -> str:
        blob = json.dumps(
            {f: [l.model_dump() for l in ls] for f, ls in sorted(self.by_family.items())},
            sort_keys=True, separators=(",", ":"),
        )
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


class StaticPlaybook(BaseModel):
    """Condition D: hand-written best-practice advice per family, content-hashed and frozen.

    ``author_frozen`` must be True for a *real* run: it certifies the playbook was written by
    an independent author and frozen. Test fixtures set it False, which the harness's
    real-run guard rejects — so a fixture can never masquerade as the final D.
    """

    by_family: dict[str, list[str]] = Field(default_factory=dict)
    author_frozen: bool = False
    author: str = "fixture"

    def advice_for(self, family: str) -> list[str]:
        return list(self.by_family.get(family, []))

    def content_hash(self) -> str:
        blob = json.dumps(self.by_family, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


class PlaceboRouter(BaseModel):
    """Hash-locked family → other-family mapping for B1. No fixed point (route(x) != x)."""

    mapping: dict[str, str]

    @classmethod
    def build(cls, families: Optional[list[str]] = None) -> "PlaceboRouter":
        fams = sorted(set(families or SEMANTIC_FAMILIES))
        n = len(fams)
        if n < 2:
            raise ValueError("placebo routing needs >= 2 families")
        r = max(1, n // 2)                       # 1 <= r <= n-1  ⇒  (i+r) % n != i  ⇒  no self-map
        mapping = {f: fams[(i + r) % n] for i, f in enumerate(fams)}
        return cls(mapping=mapping)

    def route(self, family: str) -> str:
        target = self.mapping[family]
        if target == family:                     # defensive: never route to self
            raise ValueError(f"placebo self-mapped {family!r}")
        return target

    def map_hash(self) -> str:
        blob = json.dumps(self.mapping, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


class MemoryContext(BaseModel):
    """The resolved memory slot for one (condition, task-family). Shape identical across C/B1/D."""

    condition: str
    component_kind: str
    source_family: Optional[str] = None       # which family's content was injected
    lesson_ids: list[str] = Field(default_factory=list)
    lines: list[str] = Field(default_factory=list)


def _lesson_lines(lessons: list[Lesson]) -> list[str]:
    lines: list[str] = []
    for l in lessons:
        lines.extend(l.recommended_action)
        lines.extend(f"avoid: {a}" for a in l.avoid)
    return lines


def resolve_memory(
    condition: str,
    task_family: str,
    *,
    bank: Optional[FrozenLessonBank] = None,
    playbook: Optional[StaticPlaybook] = None,
    placebo: Optional[PlaceboRouter] = None,
) -> MemoryContext:
    """Build the injected memory slot for one condition. This is the ONLY per-condition variation."""
    if condition == "A":
        return MemoryContext(condition="A", component_kind=KIND_NONE)
    if condition == "C":
        if bank is None:
            raise ValueError("condition C requires a lesson bank")
        ls = bank.lessons_for(task_family)
        return MemoryContext(condition="C", component_kind=KIND_FAMILY_RELEVANT,
                             source_family=task_family, lesson_ids=[l.lesson_id for l in ls],
                             lines=_lesson_lines(ls))
    if condition == "B1":
        if bank is None or placebo is None:
            raise ValueError("condition B1 requires a lesson bank and a placebo router")
        other = placebo.route(task_family)
        ls = bank.lessons_for(other)
        return MemoryContext(condition="B1", component_kind=KIND_OTHER_FAMILY,
                             source_family=other, lesson_ids=[l.lesson_id for l in ls],
                             lines=_lesson_lines(ls))
    if condition == "D":
        if playbook is None:
            raise ValueError("condition D requires a static playbook")
        advice = playbook.advice_for(task_family)
        return MemoryContext(condition="D", component_kind=KIND_STATIC_PLAYBOOK,
                             source_family=task_family, lines=list(advice))
    raise ValueError(f"unknown condition {condition!r}")


def render_lines(mc: MemoryContext) -> list[str]:
    """Render the memory slot to the fixed injected format. Empty for the no-memory baseline.

    The tag line is machine-readable so a routing test-double (and audits) can verify WHICH
    family's content actually arrived — without changing the shape across C/B1/D.
    """
    if mc.component_kind == KIND_NONE:
        return []
    tag = f"@@MEM kind={mc.component_kind} family={mc.source_family or '-'}"
    return [tag, *(f"- {ln}" for ln in mc.lines)]


def parse_mem_tag(context_lines: list[str]) -> tuple[str, Optional[str]]:
    """Inverse of the tag line: (component_kind, source_family). ('none', None) if absent."""
    for ln in context_lines:
        if ln.startswith("@@MEM "):
            parts = dict(p.split("=", 1) for p in ln[len("@@MEM "):].split() if "=" in p)
            fam = parts.get("family")
            return parts.get("kind", KIND_NONE), (None if fam in (None, "-") else fam)
    return KIND_NONE, None
