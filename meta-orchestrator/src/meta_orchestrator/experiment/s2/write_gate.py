"""Condition-C write-gate (Decision C): the model PROPOSES, deterministic code DECIDES.

The model is never proposer + judge + promoter. On each C *train* task the solver emits a
candidate lesson alongside its patch; this module decides, with no LLM call and no hidden
evidence beyond the verifier's PASS/FAIL, whether that candidate is written to the bank.

All eight checks must hold (Decision C):
  1. task is TRAIN (never write from a held-out task);
  2. final verifier PASS;
  3. schema-valid candidate (a Lesson with at least one recommended_action);
  4. no leak — reuses ``validate_lesson`` (no paths / line numbers / literals / code / answers)
     plus caller-supplied forbidden values (e.g. hidden-test literals);
  5. no duplicate / contradiction with an existing lesson in the family;
  6. family comes from the FROZEN taxonomy and equals the task family — never the model's label;
  7. slot budget not exceeded (``max_active_entries_per_family``, format-parity with D);
  8. candidate selection is a deterministic ranking (stable, tie-broken by source_task_id).

Held-out never writes: ``learn_gated_bank`` runs only over train, and the returned bank is
frozen, so any later ``bank.add`` during held-out raises ``MemoryFrozenError`` (a noisy failure).
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from ..lesson import Lesson, LessonRejected, validate_lesson
from .families import is_known_family
from .memory import FrozenLessonBank

# Format-parity with D (Decision C): at most this many active entries per family.
MAX_ACTIVE_ENTRIES_PER_FAMILY = 2


class HeldOutWriteError(RuntimeError):
    """A learning write was attempted from a held-out task — forbidden (Decision C/D)."""


class WriteGateResult(BaseModel):
    written: bool
    reasons: list[str] = Field(default_factory=list)   # failed-check labels; empty when written


def _contradicts(a: Lesson, b: Lesson) -> bool:
    """A crude, deterministic contradiction test: one lesson recommends what the other avoids."""
    a_rec = {s.strip().lower() for s in a.recommended_action}
    b_avoid = {s.strip().lower() for s in b.avoid}
    a_avoid = {s.strip().lower() for s in a.avoid}
    b_rec = {s.strip().lower() for s in b.recommended_action}
    return bool((a_rec & b_avoid) or (a_avoid & b_rec))


def _duplicates(a: Lesson, b: Lesson) -> bool:
    if a.lesson_id == b.lesson_id:
        return True
    return {s.strip().lower() for s in a.recommended_action} == \
           {s.strip().lower() for s in b.recommended_action}


def evaluate_write_gate(
    candidate: Optional[Lesson],
    *,
    is_train: bool,
    verifier_passed: bool,
    task_family: str,
    existing: list[Lesson],
    forbidden_values: Optional[list[str]] = None,
    max_active: int = MAX_ACTIVE_ENTRIES_PER_FAMILY,
) -> WriteGateResult:
    """Deterministically decide whether ``candidate`` may be written. Never raises on content."""
    reasons: list[str] = []
    if candidate is None:
        return WriteGateResult(written=False, reasons=["no_candidate"])
    # (1) train only
    if not is_train:
        reasons.append("not_train")
    # (2) verifier PASS
    if not verifier_passed:
        reasons.append("verifier_failed")
    # (3) schema-valid
    if not candidate.recommended_action:
        reasons.append("empty_recommended_action")
    # (6) family from the frozen taxonomy AND equal to the task family (not the model's label)
    if not is_known_family(candidate.task_family):
        reasons.append("family_not_in_taxonomy")
    if candidate.task_family != task_family:
        reasons.append("family_mismatch")
    # (4) no leak / replay
    try:
        validate_lesson(candidate, forbidden_values)
    except LessonRejected as exc:
        reasons.append(f"leak:{exc}")
    # (5) no duplicate / contradiction with existing lessons in the family
    if any(_duplicates(candidate, e) for e in existing):
        reasons.append("duplicate")
    if any(_contradicts(candidate, e) for e in existing):
        reasons.append("contradiction")
    # (7) slot budget (format-parity with D)
    if len(existing) >= max_active:
        reasons.append("slot_budget_exceeded")
    return WriteGateResult(written=not reasons, reasons=reasons)


def _rank_key(item: tuple[str, Lesson]) -> tuple:
    """(8) Deterministic ranking: more support first, then stable by source_task_id then id."""
    source_task_id, lesson = item
    support = lesson.evidence.successes - lesson.evidence.failures
    return (-support, source_task_id, lesson.lesson_id)


def learn_gated_bank(
    proposals: list[tuple[str, str, bool, Optional[Lesson]]],
    *,
    forbidden_values: Optional[list[str]] = None,
    max_active: int = MAX_ACTIVE_ENTRIES_PER_FAMILY,
) -> tuple[FrozenLessonBank, list[dict]]:
    """Build a frozen bank from TRAIN proposals through the deterministic write-gate.

    ``proposals`` is a list of ``(source_task_id, task_family, verifier_passed, candidate)``
    from train tasks only. Candidates are ranked deterministically, then admitted one by one
    (so the slot-budget and dedup checks see already-admitted lessons). Returns the frozen bank
    plus a per-candidate audit trail. Nothing here is held-out; the bank is frozen on return.
    """
    ranked = sorted(
        [(stid, fam, ok, cand) for (stid, fam, ok, cand) in proposals if cand is not None],
        key=lambda t: _rank_key((t[0], t[3])),
    )
    by_family: dict[str, list[Lesson]] = {}
    audit: list[dict] = []
    for stid, fam, ok, cand in ranked:
        existing = by_family.get(fam, [])
        res = evaluate_write_gate(cand, is_train=True, verifier_passed=ok, task_family=fam,
                                  existing=existing, forbidden_values=forbidden_values,
                                  max_active=max_active)
        audit.append({"source_task_id": stid, "family": fam, "lesson_id": cand.lesson_id,
                      "written": res.written, "reasons": res.reasons})
        if res.written:
            by_family.setdefault(fam, []).append(cand)
    return FrozenLessonBank(by_family=by_family, frozen=True), audit
