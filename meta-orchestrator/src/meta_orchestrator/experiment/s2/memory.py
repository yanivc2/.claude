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

from pydantic import BaseModel, ConfigDict, Field

from ..lesson import Lesson
from .families import SEMANTIC_FAMILIES

CONDITIONS = ["A", "C", "D", "B1"]

# Shared memory-slot budget (Decision C: identical size/format across C/B1/D so no condition
# gets a "more text / richer format" advantage). Enforced by render_lines for EVERY condition
# via one deterministic truncation. D's validator enforces the same cap before freeze.
SLOT_MAX_LINES = 8       # max content bullets injected (excludes the @@MEM tag line)
SLOT_MAX_CHARS = 200     # max chars per bullet (deterministic hard truncation)

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


FROZEN_FOLD_BANK_FILENAME = "s2_fold1_c_bank.frozen.json"
FOLD_BANK_VERSION = "s2-fold1-c-bank-v1"


def load_frozen_fold_bank(corpus_dir: str) -> FrozenLessonBank:
    """Load + verify the frozen Fold-1 Condition-C lesson bank (learned from the final sequence).

    Blocks on missing / wrong-version / bank-content-hash or artifact-content-hash mismatch. The
    returned bank is frozen (immutable) and is injected as memory for SAME-FAMILY C tasks only.
    """
    import os

    from .gate_error import GateError
    path = os.path.join(corpus_dir, FROZEN_FOLD_BANK_FILENAME)
    if not os.path.exists(path):
        raise GateError(f"frozen fold bank missing: {path}")
    raw = json.load(open(path))
    if raw.get("schema_version") != FOLD_BANK_VERSION:
        raise GateError(f"fold bank version {raw.get('schema_version')!r} != {FOLD_BANK_VERSION!r}")
    stored_hash = raw.get("content_hash", "")
    payload = json.dumps({k: v for k, v in raw.items() if k != "content_hash"},
                         sort_keys=True, separators=(",", ":"))
    if hashlib.sha256(payload.encode()).hexdigest()[:16] != stored_hash:
        raise GateError("fold bank artifact content_hash mismatch (stale or hand-edited)")
    bank = FrozenLessonBank(
        by_family={f: [Lesson(**l) for l in ls] for f, ls in raw.get("by_family", {}).items()},
        frozen=True)
    if bank.content_hash() != raw.get("bank_content_hash"):
        raise GateError("fold bank lesson content_hash mismatch")
    return bank


class StaticPlaybook(BaseModel):
    """Condition D: hand-written best-practice advice per family, content-hashed and frozen.

    ``author_frozen`` must be True for a *real* run: it certifies the playbook was written by
    an independent author and frozen. Test fixtures set it False, which the harness's
    real-run guard rejects — so a fixture can never masquerade as the final D. The model is
    immutable (frozen) so no field can be reassigned after construction.
    """

    model_config = ConfigDict(frozen=True)

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
    # One deterministic budget applied to EVERY condition → no length/format advantage.
    capped = [ln[:SLOT_MAX_CHARS] for ln in mc.lines[:SLOT_MAX_LINES]]
    return [tag, *(f"- {ln}" for ln in capped)]


class OccupancyParity(BaseModel):
    """Per-family C-vs-B1 slot-occupancy comparison (P0.5). ``equal`` False ⇒ a length confound:
    B1 gets more/less text than C, so 'relevance' is no longer the only thing that varies."""

    family: str
    c_lines: int
    b1_lines: int
    c_family: str
    b1_family: str
    equal: bool


def occupancy_parity(bank: "FrozenLessonBank", placebo: "PlaceboRouter",
                     families: list[str]) -> list[OccupancyParity]:
    """For each task family, compare the number of rendered memory lines C vs B1 would inject.

    B1 reuses C's bank keyed to a DIFFERENT family; if that family holds a different number of
    lessons, B1's injected text length differs from C's and the placebo stops being a clean
    relevance control. This surfaces that mismatch so the harness can log/flag it.
    """
    reports: list[OccupancyParity] = []
    for fam in families:
        c_lines = len(render_lines(resolve_memory("C", fam, bank=bank)))
        b1_lines = len(render_lines(resolve_memory("B1", fam, bank=bank, placebo=placebo)))
        reports.append(OccupancyParity(
            family=fam, c_lines=c_lines, b1_lines=b1_lines, c_family=fam,
            b1_family=placebo.route(fam), equal=(c_lines == b1_lines)))
    return reports


def parse_mem_tag(context_lines: list[str]) -> tuple[str, Optional[str]]:
    """Inverse of the tag line: (component_kind, source_family). ('none', None) if absent."""
    for ln in context_lines:
        if ln.startswith("@@MEM "):
            parts = dict(p.split("=", 1) for p in ln[len("@@MEM "):].split() if "=" in p)
            fam = parts.get("family")
            return parts.get("kind", KIND_NONE), (None if fam in (None, "-") else fam)
    return KIND_NONE, None
