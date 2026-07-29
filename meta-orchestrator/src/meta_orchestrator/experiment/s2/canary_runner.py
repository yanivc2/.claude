"""Canary runner — one bounded C-training attempt end-to-end around the live model call.

Ties the pieces the pilot will use for real: memory resolution → ModelBackedRoundSolver → the
bounded ``run_attempt`` (patch apply, 4-state public tests, optional R2, single hidden verify) →
the deterministic write-gate on any candidate lesson → cost reconciliation from the ledger/journal
→ a conservative reforecast of the remaining training tasks.

Isolation: ALL mutable state (budget ledger, call journal, any artifact) lives under the
caller-supplied ``work_dir``. The runner writes to NO official location — no official bank, RunLog,
spend ledger, curriculum cursor, or completion state. When ``non_authoritative`` is set every result
is stamped so a dry-run can never be mistaken for the real run.
"""
from __future__ import annotations

import hashlib
import json
import os
from decimal import Decimal
from typing import Callable, Optional

from ..contract import AgentContract
from ..lesson import Lesson
from .call_journal import BudgetLedger, CallJournal, classify_journal_terminal
from .canary_prompt import assert_frozen_pieces_match
from .contract_s2 import frozen_s2_contract
from .endpoint import EndpointAttestation, assert_endpoint_approved
from .live_solver import ModelBackedRoundSolver
from .pricing import PricingArtifact
from .forbidden_tokens import load_frozen_forbidden_tokens
from .gate_error import GateError
from .solver import AttemptContract, run_attempt
from ..task import ExperimentTask
from .write_gate import evaluate_write_gate

NON_AUTHORITATIVE_TAG = "NON_AUTHORITATIVE_FAKE_TRANSPORT"


def _bank_hash(lessons: list[Lesson]) -> str:
    payload = sorted(json.dumps(l.model_dump(), sort_keys=True) for l in lessons)
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:12]


def run_canary(task: ExperimentTask, *, client, statement: str, pricing: PricingArtifact,
               endpoint_att: EndpointAttestation, work_dir: str, count_fn: Callable[[dict], int],
               fold: int = 1, condition: str = "C", is_train: bool = True,
               memory_lines: Optional[list[str]] = None, fold_cap_usd: float = 10.00,
               env_hash: str = "", context_cap: int = 60416, run_id: str = "canary",
               remaining_train_tasks: int = 17, per_task_original_estimate_usd: float = 0.25,
               non_authoritative: bool = True,
               agent_contract: Optional[AgentContract] = None,
               frozen_template: Optional[dict] = None,
               execution_grant=None, grant_ledger_path: Optional[str] = None,
               forbidden_values: Optional[list[str]] = None) -> dict:
    os.makedirs(work_dir, exist_ok=True)
    agent_contract = agent_contract or frozen_s2_contract()
    if frozen_template is not None:
        assert_frozen_pieces_match(frozen_template)          # single-source guarantee before spending
    assert_endpoint_approved(endpoint_att, pricing)          # fail fast if the endpoint isn't approved

    ledger = BudgetLedger(os.path.join(work_dir, "ledger.json"), total_budget=fold_cap_usd)
    journal = CallJournal(os.path.join(work_dir, "journal.jsonl"))
    contract_hash = agent_contract.snapshot()[:16]

    # Persistent, restart-safe grant usage ledger (makes the grant non-replayable). When a grant is
    # supplied it MUST have a ledger; the path is derived from the grant so a restart re-opens it.
    grant_ledger = None
    if execution_grant is not None:
        from .execution_grant import GrantUsageLedger
        grant_ledger = GrantUsageLedger(grant_ledger_path
                                        or os.path.join(work_dir, "grant_ledger.json"))

    solver = ModelBackedRoundSolver(
        client=client, statement=statement, allowed_source_files=list(task.source),
        task_family=task.task_family, is_train=is_train, pricing=pricing, endpoint_att=endpoint_att,
        ledger=ledger, journal=journal, fold=fold, condition=condition, context_cap=context_cap,
        count_fn=count_fn, run_id=run_id, env_hash=env_hash, contract_hash=contract_hash,
        active_bank_hash=_bank_hash([]), task_id=task.task_id, execution_grant=execution_grant,
        grant_ledger=grant_ledger)

    try:
        attempt = run_attempt(task, condition, list(memory_lines or []), solver, agent_contract,
                              AttemptContract(), is_train=is_train,
                              provenance_extra={"run_kind": NON_AUTHORITATIVE_TAG if non_authoritative
                                                else "authoritative_canary"})
    finally:
        # Seal the grant against replay once the task is done (terminal outcome OR a raise): the same
        # grant can never re-run this task, and task 2 was never authorized by it.
        if grant_ledger is not None:
            grant_ledger.mark_complete(execution_grant)

    # --- write-gate on the candidate lesson (bank starts empty for the first C-training task) ---
    bank_before = _bank_hash([])
    # Reference-fix leakage screen: the FROZEN, provenance-aware forbidden tokens for this task
    # (new fix-only identifiers), NOT every word in the fix file. Unknown/synthetic ids → empty.
    if forbidden_values is not None:
        forbidden = forbidden_values
    else:
        corpus_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.dirname(os.path.abspath(__file__)))))), "corpus")
        try:
            forbidden = load_frozen_forbidden_tokens(corpus_dir).for_task(getattr(task, "task_id", ""))
        except GateError:
            forbidden = []
    written: list[Lesson] = []
    gate_audits = []
    for cand in attempt.candidate_lessons:
        res = evaluate_write_gate(cand, is_train=is_train, verifier_passed=attempt.passed,
                                  task_family=task.task_family, existing=written,
                                  forbidden_values=forbidden)
        gate_audits.append({"lesson_id": cand.lesson_id, "written": res.written,
                            "reasons": res.reasons})
        if res.written:
            written.append(cand)
    bank_after = _bank_hash(written)

    # --- reconciliation from the ledger + journal ---
    ledger_state = json.load(open(ledger.path)) if os.path.exists(ledger.path) else {"spent": 0.0}
    actual_spent = float(ledger_state.get("spent", 0.0))
    call_terminals = {call["call_id"]: classify_journal_terminal(journal.states_for(call["call_id"]))
                      for call in solver.calls}
    all_complete = all(t == "complete" for t in call_terminals.values()) if call_terminals else False

    # --- conservative reforecast for the remaining training tasks ---
    per_task_actual = actual_spent / max(1, len(solver.calls))
    conservative_per_task = max(per_task_actual * 1.25, per_task_original_estimate_usd)
    projected_remaining = conservative_per_task * remaining_train_tasks
    projected_total_fold1 = actual_spent + projected_remaining
    fits_after = projected_total_fold1 <= fold_cap_usd

    return {
        "tag": NON_AUTHORITATIVE_TAG if non_authoritative else "authoritative_canary",
        "task_id": task.task_id, "fold": fold, "condition": condition, "is_train": is_train,
        "attempt": {"passed": attempt.passed, "rounds_used": attempt.rounds_used,
                    "model_calls": attempt.model_calls, "patches_applied": attempt.patches_applied,
                    "round1_public_status": attempt.round1_public_status,
                    "round2_opened": attempt.round2_opened,
                    "failing_gate": attempt.failing_gate,
                    "f2p_feedback_leaked": attempt.f2p_feedback_leaked,
                    "candidate_lessons": len(attempt.candidate_lessons)},
        "per_call": solver.calls,
        "journal_terminals": call_terminals, "all_calls_complete": all_complete,
        "write_gate": {"bank_before": bank_before, "bank_after": bank_after,
                       "written": len(written), "audits": gate_audits},
        "cost": {"actual_spent_usd": round(actual_spent, 6),
                 "ledger_reserved_usd": round(float(ledger_state.get("reserved", 0.0)), 6)},
        "reforecast": {"per_task_actual_usd": round(per_task_actual, 6),
                       "conservative_per_task_usd": round(conservative_per_task, 6),
                       "projected_remaining_usd": round(projected_remaining, 4),
                       "projected_total_fold1_usd": round(projected_total_fold1, 4),
                       "fold1_cap_usd": fold_cap_usd, "fits_after_canary": fits_after},
    }
