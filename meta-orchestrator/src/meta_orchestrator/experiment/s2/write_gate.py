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


class FoldLeakageError(RuntimeError):
    """A fold's bank carries a lesson whose provenance is outside that fold's train set."""


_PROV_SEP = "::"                                     # provenance tag: "fold{idx}::{source_task_id}"


def _stamp_provenance(lesson: Lesson, source_task_id: str, fold: Optional[int]) -> Lesson:
    """Return a copy of ``lesson`` whose evidence records where it came from (never mutate input)."""
    tag = f"fold{fold}{_PROV_SEP}{source_task_id}" if fold is not None else source_task_id
    ev = lesson.evidence.model_copy(update={"supporting_runs": [tag]})
    return lesson.model_copy(update={"evidence": ev})


def bank_provenance(bank: FrozenLessonBank) -> set[str]:
    """The set of SOURCE TASK IDS every lesson in the bank was learned from."""
    out: set[str] = set()
    for lessons in bank.by_family.values():
        for l in lessons:
            for run in l.evidence.supporting_runs:
                out.add(run.split(_PROV_SEP)[-1])    # strip the optional fold tag
    return out


def assert_bank_within_train(bank: FrozenLessonBank, train_ids: list[str]) -> None:
    """Loud tripwire: a fold bank must only carry lessons learned from that fold's TRAIN tasks."""
    train = set(train_ids)
    leaked = bank_provenance(bank) - train
    if leaked:
        raise FoldLeakageError(
            f"bank carries lessons from non-train tasks {sorted(leaked)} (cross-fold leakage)")


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


def reference_patch_tokens(reference_fix: dict[str, str], *, min_len: int = 5) -> list[str]:
    """Evaluator-side leak screen (P0.review): rare identifiers unique to the reference fix.

    A real model can replay a memorised fix WITHOUT using a path or line number, so the pilot
    passes these tokens as ``forbidden_values`` to ``evaluate_write_gate`` — a candidate lesson
    that echoes a rare fix identifier is rejected. The model never sees this list; it is derived
    from the EVALUATOR-ONLY reference fix. Common short/keyword tokens are excluded.
    """
    import keyword
    import re
    common = set(keyword.kwlist) | {"return", "value", "result", "output", "input", "print",
                                    "self", "None", "True", "False", "assert", "range"}
    toks: set[str] = set()
    for body in reference_fix.values():
        for m in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", body):
            if len(m) >= min_len and m not in common:
                toks.add(m)
    return sorted(toks)


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
    fold: Optional[int] = None,
) -> tuple[FrozenLessonBank, list[dict]]:
    """Build a frozen bank from TRAIN proposals through the deterministic write-gate.

    ``proposals`` is a list of ``(source_task_id, task_family, verifier_passed, candidate)``
    from train tasks only. Candidates are ranked deterministically, then admitted one by one
    (so the slot-budget and dedup checks see already-admitted lessons). Every written lesson is
    stamped with its provenance (``fold`` + ``source_task_id``) so a cross-fold leak is
    detectable by ``assert_bank_within_train``. Nothing here is held-out; the bank is frozen.
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
            by_family.setdefault(fam, []).append(_stamp_provenance(cand, stid, fold))
    return FrozenLessonBank(by_family=by_family, frozen=True), audit
