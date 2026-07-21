"""Held-out evaluation infrastructure ($0) — condition memory, sealed outcomes, eval runner.

Three pieces, built for the fold-1 A/C/D/B1 held-out phase and reusable for later folds:

  * ``resolve_eval_memory`` — the ONLY per-condition variation at evaluation: the label-free
    memory payload for one (condition, task-family) against the FROZEN bank / playbook. B1 is
    count-matched to C via the frozen fallback policy. A and an uncovered-family C inject nothing
    (Option B). Every payload is guarded against condition-label sentinels.

  * ``SealedOutcomeStore`` — Decision E's keep-honest operationalization: every eval attempt's
    full report is recorded append-only, hash-chained, and OBFUSCATED (base64 payload) so a casual
    status check cannot read outcomes. Each record carries a small ``visible`` block restricted to
    the pre-declared continue/stop signals (cost / harness health / grant accounting) — outcome
    keys are structurally rejected there. ``outcome_table`` refuses to decode until an explicit
    pre-declared unseal reason is presented (all folds complete, or a pre-declared stop trigger).

  * ``run_heldout_eval_task`` — a thin wrapper over the ONE paid path (``run_real_task_canary``)
    hard-locked to evaluation semantics: ``is_train=False`` (no LESSON schema in the prompt, no
    candidate, write-gate never reached), grant must be phase='heldout_eval' and bound to this
    exact (condition, task); the frozen bank is asserted unchanged after the attempt; the full
    report goes into the sealed store and the CALLER receives only a redacted report with the
    outcome fields stripped.

Held-out evaluation NEVER writes memory: the bank is frozen (``MemoryFrozenError`` on add), the
solver collects no candidate when ``is_train=False``, and the runner re-asserts the bank hash.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Optional

from pydantic import BaseModel, Field

from . import real_canary as RC
from .gate_error import GateError
from .memory import (KIND_FAMILY_RELEVANT, KIND_NONE, KIND_OTHER_FAMILY, KIND_STATIC_PLAYBOOK,
                     FrozenLessonBank, MemoryContext, StaticPlaybook, _bank_rank_key,
                     _lesson_lines, assert_no_condition_label, b1_source_family, resolve_memory)
from .ordering import PRIMARY_CONDITIONS, STABILITY_CONDITIONS, condition_order
from .prompt import render_memory_payload

EVAL_PHASE = "heldout_eval"
EVAL_PLAN_VERSION = "s2-heldout-eval-plan-v1"

# Pre-declared unseal reasons (Decision E): the outcome table opens ONLY when the experiment's
# frozen procedure says so — never for a mid-run peek, a progress report, or a continue decision.
UNSEAL_ALL_FOLDS_COMPLETE = "all_folds_complete"
UNSEAL_PREDECLARED_STOP = "predeclared_stop_trigger"
UNSEAL_REASONS = frozenset({UNSEAL_ALL_FOLDS_COMPLETE, UNSEAL_PREDECLARED_STOP})

# Continue/stop may read ONLY these (stability / cost / harness health / grant accounting).
ALLOWED_VISIBLE_KEYS = frozenset({
    "cost_usd", "calls_sent", "infra_status", "ambiguous_held", "grant_completed",
    "context_ok", "retry_count",
})
# Outcome-bearing keys that must NEVER appear in a visible block or a redacted report.
FORBIDDEN_OUTCOME_KEYS = frozenset({
    "hidden_verdict", "public_statuses", "solver_outcome", "round2_opened", "patch_applied",
    "hidden_verify_count", "write_gate_written", "round_classifications", "patch_statuses",
    "task_trace", "bank_hash_after", "memory_telemetry",
})
# The caller-facing redacted report: strictly the operational subset.
REDACTED_REPORT_KEYS = (
    "task_id", "calls_sent", "per_call", "reserved_usd", "reconciled_usd",
    "budget_available_after", "journal_terminals", "grant_calls_used", "grant_calls_remaining",
    "grant_completed", "ambiguous_held", "network_isolation",
)


class SealedOutcomesError(GateError):
    """The outcome table was requested without a pre-declared unseal reason (or the chain broke)."""


class EvalMemory(BaseModel):
    """The resolved, label-free memory payload for one (condition, task-family) at evaluation."""

    condition: str
    component_kind: str
    source_family: Optional[str] = None
    lesson_ids: list[str] = Field(default_factory=list)
    item_count: int = 0
    payload: list[str] = Field(default_factory=list)      # label-free bullets (paid-path legal)


def resolve_eval_memory(condition: str, task_family: str, *, bank: FrozenLessonBank,
                        playbook: Optional[StaticPlaybook] = None) -> EvalMemory:
    """Resolve the injected memory for one held-out attempt. B1 is COUNT-MATCHED to C (frozen
    fallback policy, fail-closed); an empty slot injects nothing (Option B) for every condition."""
    if condition == "A":
        return EvalMemory(condition="A", component_kind=KIND_NONE)
    if condition == "C":
        mc = resolve_memory("C", task_family, bank=bank)
        payload = render_memory_payload(mc) if mc.lines else []
        em = EvalMemory(condition="C", component_kind=KIND_FAMILY_RELEVANT,
                        source_family=task_family, lesson_ids=mc.lesson_ids,
                        item_count=len(mc.lesson_ids), payload=payload)
    elif condition == "B1":
        n_c = len(resolve_memory("C", task_family, bank=bank).lesson_ids)
        if n_c == 0:
            return EvalMemory(condition="B1", component_kind=KIND_OTHER_FAMILY, item_count=0)
        source = b1_source_family(task_family, bank=bank, required_count=n_c)   # fail-closed
        picked = sorted(bank.lessons_for(source), key=_bank_rank_key)[:n_c]
        mc = MemoryContext(condition="B1", component_kind=KIND_OTHER_FAMILY, source_family=source,
                           lesson_ids=[l.lesson_id for l in picked], lines=_lesson_lines(picked))
        em = EvalMemory(condition="B1", component_kind=KIND_OTHER_FAMILY, source_family=source,
                        lesson_ids=mc.lesson_ids, item_count=n_c,
                        payload=render_memory_payload(mc))
    elif condition == "D":
        if playbook is None:
            raise GateError("condition D requires the frozen static playbook")
        if not playbook.author_frozen:
            raise GateError("condition D requires an author-frozen playbook (fixture rejected)")
        mc = resolve_memory("D", task_family, playbook=playbook)
        em = EvalMemory(condition="D", component_kind=KIND_STATIC_PLAYBOOK,
                        source_family=task_family, item_count=len(mc.lines),
                        payload=render_memory_payload(mc) if mc.lines else [])
    else:
        raise GateError(f"unknown evaluation condition {condition!r}")
    # Defense in depth: a label-free payload can never carry a frozen condition sentinel.
    assert_no_condition_label(*em.payload, where=f"eval memory payload ({condition}/{task_family})")
    return em


# --- sealed outcome store ------------------------------------------------------------------------


def _entry_hash(entry: dict) -> str:
    doc = {k: v for k, v in entry.items() if k != "entry_hash"}
    return hashlib.sha256(json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
                          ).hexdigest()[:16]


class SealedOutcomeStore:
    """Append-only, hash-chained, obfuscated store for held-out outcome reports.

    Sealing is PROCEDURAL, not cryptographic: the payload is base64-obfuscated so no outcome is
    readable in a casual file/status inspection, the chain proves order + integrity, and
    ``outcome_table`` refuses to decode without a pre-declared unseal reason. Deliberately reading
    the raw file outside ``outcome_table`` is a protocol violation by definition (Decision E)."""

    GENESIS = "genesis"

    def __init__(self, path: str):
        self.path = path

    def _entries(self) -> list[dict]:
        if not os.path.exists(self.path):
            return []
        return [json.loads(ln) for ln in open(self.path).read().splitlines() if ln.strip()]

    def count(self) -> int:
        return len(self._entries())

    def record(self, full_report: dict, *, task_id: str, condition: str, rep: int,
               visible: dict) -> dict:
        """Append one sealed record. ``visible`` is restricted to the pre-declared continue/stop
        signal keys; any outcome-bearing key is structurally rejected (fail-closed)."""
        bad = set(visible) - set(ALLOWED_VISIBLE_KEYS)
        if bad:
            raise SealedOutcomesError(
                f"visible block carries non-pre-declared keys {sorted(bad)!r} — only "
                f"{sorted(ALLOWED_VISIBLE_KEYS)} are legal continue/stop signals")
        leak = set(visible) & set(FORBIDDEN_OUTCOME_KEYS)
        if leak:                                            # unreachable given the whitelist; belt+braces
            raise SealedOutcomesError(f"visible block carries OUTCOME keys {sorted(leak)!r}")
        entries = self._entries()
        prev = entries[-1]["entry_hash"] if entries else self.GENESIS
        payload = json.dumps(full_report, sort_keys=True, separators=(",", ":"))
        entry = {
            "seq": len(entries), "task_id": task_id, "condition": condition, "rep": rep,
            "visible": dict(visible),
            "payload_b64": base64.b64encode(payload.encode()).decode("ascii"),
            "payload_sha256": hashlib.sha256(payload.encode()).hexdigest(),
            "prev_hash": prev,
        }
        entry["entry_hash"] = _entry_hash(entry)
        with open(self.path, "a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
        return {k: entry[k] for k in ("seq", "task_id", "condition", "rep", "visible",
                                      "entry_hash")}

    def verify_chain(self) -> int:
        """Recompute every hash + link; raise ``SealedOutcomesError`` on any break/tamper."""
        prev = self.GENESIS
        for i, e in enumerate(self._entries()):
            if e.get("seq") != i or e.get("prev_hash") != prev or _entry_hash(e) != e.get("entry_hash"):
                raise SealedOutcomesError(f"sealed-outcome chain broken at seq {i} (tamper or loss)")
            raw = base64.b64decode(e["payload_b64"]).decode()
            if hashlib.sha256(raw.encode()).hexdigest() != e["payload_sha256"]:
                raise SealedOutcomesError(f"sealed payload digest mismatch at seq {i}")
            prev = e["entry_hash"]
        return self.count()

    def visible_summaries(self) -> list[dict]:
        """The continue/stop view: ONLY the pre-declared visible signals, never outcomes."""
        self.verify_chain()
        return [{"seq": e["seq"], "task_id": e["task_id"], "condition": e["condition"],
                 "rep": e["rep"], **e["visible"]} for e in self._entries()]

    def outcome_table(self, *, unseal_reason: str) -> list[dict]:
        """Decode the sealed reports — ONLY under a pre-declared unseal reason (Decision E)."""
        if unseal_reason not in UNSEAL_REASONS:
            raise SealedOutcomesError(
                f"outcome table is SEALED: {unseal_reason!r} is not a pre-declared unseal reason "
                f"(allowed: {sorted(UNSEAL_REASONS)})")
        self.verify_chain()
        return [{"seq": e["seq"], "task_id": e["task_id"], "condition": e["condition"],
                 "rep": e["rep"],
                 "report": json.loads(base64.b64decode(e["payload_b64"]).decode())}
                for e in self._entries()]


# --- eval plan (frozen, outcome-independent) ------------------------------------------------------


class EvalPlanEntry(BaseModel):
    task_id: str
    task_family: str
    condition: str
    rep: int                                   # 0 = primary block, 1 = A/C stability block
    role: str                                  # "primary" | "stability"


class EvalPlan(BaseModel):
    """The pre-declared held-out execution plan: Latin-square condition order per task (primary
    block), then the A/C execution-stability block against the SAME frozen bank. Built from task
    ids + families + the frozen bank hash only — no outcome can influence it."""

    plan_version: str = EVAL_PLAN_VERSION
    heldout_fold_index: int
    bank_content_hash: str
    entries: list[EvalPlanEntry]

    def content_hash(self) -> str:
        return hashlib.sha256(json.dumps(self.model_dump(), sort_keys=True,
                                         separators=(",", ":")).encode()).hexdigest()[:16]


def build_eval_plan(heldout: dict[str, str], *, heldout_fold_index: int, bank_content_hash: str,
                    include_stability: bool = True) -> EvalPlan:
    """``heldout`` maps task_id → family. Primary: each task under all four conditions in its
    frozen Latin-square rotation; stability: each task under A and C once more (bank frozen)."""
    entries: list[EvalPlanEntry] = []
    for tid in sorted(heldout):
        for cond in condition_order(tid, PRIMARY_CONDITIONS):
            entries.append(EvalPlanEntry(task_id=tid, task_family=heldout[tid], condition=cond,
                                         rep=0, role="primary"))
    if include_stability:
        for tid in sorted(heldout):
            for cond in STABILITY_CONDITIONS:
                entries.append(EvalPlanEntry(task_id=tid, task_family=heldout[tid], condition=cond,
                                             rep=1, role="stability"))
    return EvalPlan(heldout_fold_index=heldout_fold_index, bank_content_hash=bank_content_hash,
                    entries=entries)


# --- the eval runner ------------------------------------------------------------------------------


def redact_eval_report(report: dict) -> dict:
    """The caller-facing view of one eval attempt: operational/cost/harness fields only. Outcome
    fields (hidden verdict, public statuses, round-2, patch state, …) are stripped — they live
    ONLY inside the sealed store until the pre-declared unseal."""
    red = {k: report[k] for k in REDACTED_REPORT_KEYS if k in report}
    red["infra_status"] = "ambiguous_held" if report.get("ambiguous_held") else "ok"
    leak = set(red) & set(FORBIDDEN_OUTCOME_KEYS)
    if leak:                                                # structural invariant
        raise SealedOutcomesError(f"redacted report would leak outcome keys {sorted(leak)!r}")
    return red


def run_heldout_eval_task(
    ctx, *, client, statement: str, pricing, endpoint_att, grant, grant_ledger_path: str,
    work_dir: str, count_fn, full_exposure_usd: str, fold_budget_usd: float, context_cap: int,
    env_hash: str, contract_hash: str, condition: str, bank: FrozenLessonBank,
    playbook: Optional[StaticPlaybook], store: SealedOutcomeStore, rep: int = 0,
    expected_bank_hash: Optional[str] = None, forbidden_values: Optional[list[str]] = None,
) -> dict:
    """ONE held-out attempt on the ONE paid path, hard-locked to evaluation semantics.

    Fail-closed preconditions (all BEFORE any reservation / send): a known condition; a legal rep
    role; a grant minted for phase='heldout_eval' and bound to exactly this (condition, task); a
    FROZEN bank matching ``expected_bank_hash``. The attempt runs with ``is_train=False`` (no
    LESSON schema, no candidate, no write-gate). Afterwards the bank hash is re-asserted unchanged
    and the FULL report is sealed; the caller gets only the redacted operational view."""
    if condition not in PRIMARY_CONDITIONS:
        raise GateError(f"unknown evaluation condition {condition!r}")
    if rep not in (0, 1) or (rep == 1 and condition not in STABILITY_CONDITIONS):
        raise GateError(f"illegal rep role: rep={rep} condition={condition} — the stability block "
                        f"is A/C only (rep 1), the primary block is rep 0")
    if getattr(grant, "phase", None) != EVAL_PHASE:
        raise GateError(f"grant phase {getattr(grant, 'phase', None)!r} != {EVAL_PHASE!r} — a "
                        f"training grant can never authorize a held-out call")
    if grant.condition != condition:
        raise GateError(f"grant condition {grant.condition!r} != requested {condition!r} — "
                        f"blocked before reservation")
    if grant.task_id != ctx.task_id:
        raise GateError(f"grant task {grant.task_id!r} != context task {ctx.task_id!r}")
    if not bank.frozen:
        raise GateError("held-out evaluation requires a FROZEN bank")
    bank_hash_before = bank.content_hash()
    if expected_bank_hash is not None and bank_hash_before != expected_bank_hash:
        raise GateError(f"bank hash {bank_hash_before} != expected {expected_bank_hash} — "
                        f"blocked before reservation")

    mem = resolve_eval_memory(condition, ctx.task_family, bank=bank, playbook=playbook)

    report = RC.run_real_task_canary(
        ctx, client=client, statement=statement, pricing=pricing, endpoint_att=endpoint_att,
        grant=grant, grant_ledger_path=grant_ledger_path, work_dir=work_dir, count_fn=count_fn,
        full_exposure_usd=full_exposure_usd, fold_budget_usd=fold_budget_usd,
        context_cap=context_cap, env_hash=env_hash, contract_hash=contract_hash,
        memory_lines=mem.payload, is_train=False, forbidden_values=forbidden_values)

    # zero-write proofs: the frozen bank is untouched and the write-gate wrote nothing.
    if bank.content_hash() != bank_hash_before:
        raise GateError("BANK MUTATED during held-out evaluation — protocol violation")
    if report.get("write_gate_written", 0) != 0:
        raise GateError("write-gate wrote during held-out evaluation — protocol violation")

    total_cost = f"{sum(float(c['actual_cost_usd']) for c in report.get('per_call', [])):.8f}"
    sealed = store.record(
        {**report, "memory_telemetry": mem.model_dump(), "eval_rep": rep,
         "bank_hash": bank_hash_before},
        task_id=ctx.task_id, condition=condition, rep=rep,
        visible={"cost_usd": total_cost, "calls_sent": report.get("calls_sent", 0),
                 "infra_status": "ambiguous_held" if report.get("ambiguous_held") else "ok",
                 "ambiguous_held": bool(report.get("ambiguous_held")),
                 "grant_completed": bool(report.get("grant_completed"))})
    red = redact_eval_report(report)
    red["sealed_entry_hash"] = sealed["entry_hash"]
    red["sealed_seq"] = sealed["seq"]
    return red
