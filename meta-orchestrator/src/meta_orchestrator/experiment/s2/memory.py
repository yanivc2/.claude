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
from .gate_error import GateError

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

# --- no-condition-label guard (apparatus safety net for the paid path) -----------------------------
# The memory slot is the ONLY thing that varies across A/C/D/B1, so the model must NEVER be able to
# read WHICH condition it is in. `render_lines` emits an `@@MEM kind=… family=…` header — a machine
# tag for routing test-doubles + audits, NOT for real models: `kind=family_relevant` (C),
# `kind=other_family` (B1) and `kind=static_playbook` (D) would literally announce the condition /
# the placebo target. Only the label-free `prompt.render_memory_payload` is a legal paid-path input.
#
# This guard is deliberately NARROW + deterministic: it matches ONLY the exact frozen sentinels the
# renderer / test-harness emit — derived from the constants above so the two can never drift. It does
# NOT do free-text semantic search, so ordinary task prose or code containing generic words like
# "family", "relevant", "memory" or "other" is never flagged.
MEM_TAG_SENTINEL = "@@MEM"
CONDITION_LABEL_SENTINELS = (
    MEM_TAG_SENTINEL,                          # the memory header prefix (also carries family=…)
    f"kind={KIND_FAMILY_RELEVANT}",            # C
    f"kind={KIND_OTHER_FAMILY}",               # B1
    f"kind={KIND_STATIC_PLAYBOOK}",            # D
)


class ConditionLabelLeak(GateError):
    """A frozen condition-label sentinel reached a request bound for a real model — fail-closed."""


def find_condition_label_leak(text: str) -> Optional[str]:
    """Return the first frozen condition-label sentinel present in ``text`` (else None). Narrow +
    deterministic — only the exact machine sentinels a memory render / test-harness emits."""
    for s in CONDITION_LABEL_SENTINELS:
        if s in (text or ""):
            return s
    return None


def assert_no_condition_label(*texts: str, where: str = "request") -> None:
    """Fail-closed (``ConditionLabelLeak``) if ANY of ``texts`` carries a frozen condition-label
    sentinel. Call on the ASSEMBLED prompt and on the SERIALIZED outbound body, BEFORE any budget
    reservation / grant consume / messages.create — a leak means: no reservation, no send, no grant
    consumption, no curriculum advancement (an APPARATUS failure, like the family binding)."""
    for t in texts:
        hit = find_condition_label_leak(t)
        if hit is not None:
            raise ConditionLabelLeak(
                f"CONDITION_LABEL_LEAK: frozen condition-label sentinel {hit!r} present in {where} — "
                f"blocked before send (only render_memory_payload, the label-free slot, is a legal "
                f"paid-path memory input; render_lines is a test/debug affordance and must not reach "
                f"a real model)")


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
    """Render the memory slot WITH the machine ``@@MEM kind=… family=…`` header. Empty for the
    no-memory baseline.

    TEST / DEBUG / AUDIT AFFORDANCE ONLY — the header is a routing hook so a test-double (and
    occupancy audits) can verify WHICH family's content arrived. It carries the condition label and
    therefore MUST NOT reach a real model: the paid path uses the label-free
    ``prompt.render_memory_payload`` instead, and ``assert_no_condition_label`` fail-closes any
    request that still carries one of these sentinels.
    """
    # Option B (frozen policy): an EMPTY memory slot injects NOTHING — no @@MEM tag, no placeholder —
    # uniformly across C/D/B1. So C with an empty relevant-family bank == A at the memory-block level
    # (there is genuinely nothing relevant yet), and no tokens are spent announcing an empty slot.
    if mc.component_kind == KIND_NONE or not mc.lines:
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


class MemoryOccupancyMismatch(RuntimeError):
    """C and B1 would inject a different AMOUNT of memory for a task — the placebo would then vary in
    quantity, not just relevance. An APPARATUS failure: block before any reservation / messages.create."""


# Frozen rendered-token tolerance for the C-vs-B1 length control (applies once memory is non-empty):
# block ONLY when the gap is BOTH large in absolute terms AND large relative to the larger side, so
# ordinary per-lesson wording differences pass but a real quantity confound is caught.
RENDER_TOKEN_ABS_TOL = 32
RENDER_TOKEN_REL_TOL = 0.20


def _rendered_tokens(lines: list[str]) -> int:
    """Deterministic, offline rendered-size proxy: whitespace-separated tokens of the memory block."""
    import re
    return len(re.findall(r"\S+", "\n".join(lines)))


def _gap(a: int, b: int) -> tuple[int, float]:
    """(absolute gap, relative gap = |a-b|/max(a,b)); both-zero → (0, 0.0)."""
    d = abs(a - b)
    return d, (d / max(a, b, 1))


def assert_authoritative_memory_parity(
    *, base_request_tokens: int, c_request_tokens: int, b1_request_tokens: int,
    c_memory_lines: list[str], b1_memory_lines: list[str],
    abs_tol: int = RENDER_TOKEN_ABS_TOL, rel_tol: float = RENDER_TOKEN_REL_TOL) -> dict:
    """AUTHORITATIVE C-vs-B1 memory-length gate for the FIRST content-bearing task. The memory block's
    token contribution is isolated by real ``count_tokens`` (with-memory MINUS the identical no-memory
    base request), so only the injected memory differs. Block (MEMORY_LENGTH_MISMATCH, fail-closed)
    when the authoritative gap is BOTH > ``abs_tol`` AND > ``rel_tol`` relative. The deterministic
    proxy is also evaluated; if proxy and authoritative DISAGREE on the block decision, block and
    return for investigation (the proxy may not be measuring the same canonical content)."""
    c_mem = c_request_tokens - base_request_tokens          # authoritative memory-only token counts
    b1_mem = b1_request_tokens - base_request_tokens
    abs_gap, rel_gap = _gap(c_mem, b1_mem)
    auth_block = abs_gap > abs_tol and rel_gap > rel_tol

    proxy_c, proxy_b1 = _rendered_tokens(c_memory_lines), _rendered_tokens(b1_memory_lines)
    p_abs, p_rel = _gap(proxy_c, proxy_b1)
    proxy_block = p_abs > abs_tol and p_rel > rel_tol

    tele = {"base_request_tokens": base_request_tokens, "c_request_tokens": c_request_tokens,
            "b1_request_tokens": b1_request_tokens, "c_memory_tokens": c_mem, "b1_memory_tokens": b1_mem,
            "authoritative_abs_gap": abs_gap, "authoritative_rel_gap": round(rel_gap, 4),
            "proxy_c_tokens": proxy_c, "proxy_b1_tokens": proxy_b1, "proxy_abs_gap": p_abs,
            "proxy_rel_gap": round(p_rel, 4), "abs_tol": abs_tol, "rel_tol": rel_tol,
            "authoritative_block": auth_block, "proxy_block": proxy_block}
    if auth_block:
        raise MemoryOccupancyMismatch(
            f"MEMORY_LENGTH_MISMATCH (authoritative): C_mem={c_mem} B1_mem={b1_mem} tokens "
            f"(gap={abs_gap}, rel={rel_gap:.0%}) exceeds tolerance (>{abs_tol} and >{int(rel_tol*100)}%)")
    if proxy_block != auth_block:
        raise MemoryOccupancyMismatch(
            f"proxy/authoritative DISAGREE on memory-length parity (proxy_block={proxy_block}, "
            f"authoritative_block={auth_block}) — block and investigate: {tele}")
    tele["decision"] = "pass"
    return tele


# --- B1 count-matched source selection with a FROZEN deterministic fallback ---------------------
# The primary B1 source is the frozen placebo derangement. When it cannot count-match C (too few
# lessons yet), B1 walks a FROZEN, corpus-wide cyclic family order — the primary derangement first,
# then the remaining families in the frozen sorted-cyclic order — EXCLUDING the target family, and
# picks the FIRST family that has enough DISTINCT lessons. Exactly ONE whole family is used (never a
# mix), top-n by the frozen ranking, no padding / no duplication. Fail-closed only when NO eligible
# non-target family qualifies. This keeps B1 a genuine relevance placebo (irrelevant family, same
# quantity/framing) instead of blocking a whole family of tasks because one deranged family happens
# to be empty — and the order is fixed for the whole corpus, never chosen per task or per outcome.


def b1_fallback_order(task_family: str) -> list[str]:
    """The frozen B1 source-family chain for ``task_family``: the placebo derangement first, then the
    remaining SEMANTIC_FAMILIES in the same frozen cyclic order, with the TARGET family excluded."""
    fams = sorted(set(SEMANTIC_FAMILIES))
    n = len(fams)
    r = max(1, n // 2)                                     # identical shift to PlaceboRouter.build
    i = fams.index(task_family)
    chain = [fams[(i + r + k) % n] for k in range(n)]     # starts at the primary derangement
    return [f for f in chain if f != task_family]         # exclude the target family (never self)


def _bank_rank_key(lesson: Lesson) -> tuple:
    """Frozen deterministic ranking within a family: more net support first, then source task id,
    then lesson id (mirrors write_gate._rank_key using the lesson's stamped provenance)."""
    support = lesson.evidence.successes - lesson.evidence.failures
    src = lesson.evidence.supporting_runs[-1].split("::")[-1] if lesson.evidence.supporting_runs else ""
    return (-support, src, lesson.lesson_id)


def b1_source_family(task_family: str, *, bank: "FrozenLessonBank", required_count: int) -> str:
    """The frozen fallback selection: the FIRST family in ``b1_fallback_order`` (target excluded) that
    holds at least ``required_count`` distinct lessons. Fail-closed if none qualifies."""
    for fam in b1_fallback_order(task_family):
        if len(bank.lessons_for(fam)) >= required_count:
            return fam
    raise MemoryOccupancyMismatch(
        f"B1 cannot count-match C for {task_family!r}: no eligible non-target family has >= "
        f"{required_count} distinct lessons in the frozen fallback order {b1_fallback_order(task_family)} "
        f"— fail-closed (no padding, no duplication, no cross-family mixing).")


def b1_lines_count_matched(task_family: str, *, bank: "FrozenLessonBank",
                           placebo: "PlaceboRouter") -> list[str]:
    """Render B1's memory so it holds EXACTLY the number of items C would inject for this task, drawn
    from ONE frozen non-target family (primary derangement, else the frozen fallback chain) by the
    frozen ranking. Empty C slot ⇒ [] (parity 0==0). Fail-closed if no eligible family can match."""
    n_c = len(resolve_memory("C", task_family, bank=bank).lesson_ids)
    if n_c == 0:
        return []                                         # Option B: empty slot injects nothing
    source = b1_source_family(task_family, bank=bank, required_count=n_c)
    picked = sorted(bank.lessons_for(source), key=_bank_rank_key)[:n_c]   # top-n by frozen ranking
    mc = MemoryContext(condition="B1", component_kind=KIND_OTHER_FAMILY, source_family=source,
                       lesson_ids=[l.lesson_id for l in picked], lines=_lesson_lines(picked))
    return render_lines(mc)


def assert_occupancy_parity(task_family: str, *, bank: "FrozenLessonBank",
                            placebo: "PlaceboRouter") -> dict:
    """HARD pre-send gate on memory OCCUPANCY (item count): C and the count-matched B1 must inject the
    SAME NUMBER of lessons for this task, drawn from their respective families. ``b1_lines_count_matched``
    raises MemoryOccupancyMismatch fail-closed if the deranged family cannot supply that many, so the
    caller blocks before reservation / send. Empty slots (Option B) render to [] on both sides, so a
    task with no relevant memory passes trivially (0 items == 0 items).

    Rendered LINE/char counts are returned for observability but are NOT a hard block: two DISTINCT
    real lessons have different bullet counts, so exact line equality is unachievable without the
    forbidden padding. Both sides pass through the SAME frozen render budget (SLOT_MAX_LINES /
    SLOT_MAX_CHARS), which is the structural length control; ``line_parity`` flags any residual gap for
    the audit trail."""
    c_ctx = resolve_memory("C", task_family, bank=bank)
    c_lines = render_lines(c_ctx)
    n_c = len(c_ctx.lesson_ids)
    b1_lines = b1_lines_count_matched(task_family, bank=bank, placebo=placebo)   # hard item-count gate
    # the ACTUAL B1 source family (primary derangement, or a frozen fallback when the primary is short)
    primary = placebo.route(task_family)
    b1_source = b1_source_family(task_family, bank=bank, required_count=n_c) if n_c else primary
    # rendered-token gap gate (dormant for empty slots: 0 vs 0): block only when the gap is BOTH
    # absolutely large (> RENDER_TOKEN_ABS_TOL) AND relatively large (> RENDER_TOKEN_REL_TOL).
    ct, bt = _rendered_tokens(c_lines), _rendered_tokens(b1_lines)
    diff = abs(ct - bt)
    rel = diff / max(ct, bt, 1)
    if diff > RENDER_TOKEN_ABS_TOL and rel > RENDER_TOKEN_REL_TOL:
        raise MemoryOccupancyMismatch(
            f"rendered-token gap for {task_family!r}: C={ct} B1={bt} tokens (diff={diff}, rel={rel:.0%}) "
            f"exceeds tolerance (>{RENDER_TOKEN_ABS_TOL} and >{int(RENDER_TOKEN_REL_TOL*100)}%)")
    return {"task_family": task_family, "primary_deranged_family": primary,
            "deranged_family": b1_source,                 # the family B1 actually drew from
            "b1_fallback_used": bool(n_c) and b1_source != primary,
            "c_items": n_c, "b1_items": n_c,              # matched by construction
            "c_lines": len(c_lines), "b1_lines": len(b1_lines),
            "c_tokens": ct, "b1_tokens": bt, "token_gap": diff, "token_rel": round(rel, 4),
            "item_parity": True, "line_parity": len(c_lines) == len(b1_lines),
            "render_budget": {"max_lines": SLOT_MAX_LINES, "max_chars": SLOT_MAX_CHARS}}


def parse_mem_tag(context_lines: list[str]) -> tuple[str, Optional[str]]:
    """Inverse of the tag line: (component_kind, source_family). ('none', None) if absent."""
    for ln in context_lines:
        if ln.startswith("@@MEM "):
            parts = dict(p.split("=", 1) for p in ln[len("@@MEM "):].split() if "=" in p)
            fam = parts.get("family")
            return parts.get("kind", KIND_NONE), (None if fam in (None, "-") else fam)
    return KIND_NONE, None
