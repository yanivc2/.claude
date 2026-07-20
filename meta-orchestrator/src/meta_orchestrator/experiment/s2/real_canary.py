"""RealTaskCanaryRunner (P0.7) — the ONE paid path that joins real authz/budget to real grading.

A thin orchestration layer; it re-uses (never duplicates) the frozen pieces:
  * ModelBackedRoundSolver (the single real call path: grant consume + prepared==sent + journal);
  * canary_prompt / response_parser (the one request builder + parser);
  * realtask.py (repo-backed node-level P2P/F2P under ``unshare -rn``);
  * write_gate / pricing / execution_grant ledger.

Invariants:
  * ONE atomic task-level reservation of the full R1+R2 max exposure BEFORE R1 (the solver runs in
    ``task_reservation`` mode → it does NOT reserve/reconcile per call → no double reservation);
  * Round 2 opens ONLY on a genuine public FAIL (never on PASS / NO_PUBLIC_TESTS / INFRA_ERROR /
    parse failure / invalid patch / timeout / ambiguity / any hidden verdict);
  * exactly ONE hidden verify at the very end, on the final patched source; its verdict never
    reaches the model and never opens Round 2;
  * on CALL_AMBIGUOUS_AFTER_SEND: the reservation is retained, Round 2 is blocked, the grant is NOT
    completed, nothing is auto-retried — a human decides;
  * the persistent grant ledger counts only actually-sent HTTP calls and is restart-safe.

Transport-agnostic: pass a fake client for the $0 dry-run or the real S2ModelClient for the canary.
"""
from __future__ import annotations

import json
import os
from decimal import Decimal
from typing import Callable, Optional

from . import realtask as RT
from .call_journal import BudgetLedger, CallJournal, classify_journal_terminal
from .execution_grant import GrantUsageLedger
from .families import TaskFamilyBindingError, assert_task_family_valid
from .live_solver import ModelBackedRoundSolver
from .patch_format import PatchFormatError
from .pricing import PricingArtifact
from .response_classification import (SOLVER_FAIL_TRUNCATED, TRUNCATED_OUTPUT,
                                      is_official_pass_eligible)
from .forbidden_tokens import load_frozen_forbidden_tokens
from .solver import RoundView
from .write_gate import evaluate_write_gate

TASK_RESERVED = "TASK_RESERVED"
HIDDEN_VERIFY = "HIDDEN_VERIFY"
WRITE_GATE = "WRITE_GATE"
RECONCILED = "RECONCILED"
GRANT_COMPLETED = "GRANT_COMPLETED"
TASK_CLOSED = "TASK_CLOSED"
AMBIGUOUS_HELD = "AMBIGUOUS_HELD"


def run_real_task_canary(
    ctx: RT.RealTaskContext, *, client, statement: str, pricing: PricingArtifact, endpoint_att,
    grant, grant_ledger_path: str, work_dir: str, count_fn: Callable[[dict], int],
    full_exposure_usd: str, fold_budget_usd: float, context_cap: int, env_hash: str,
    contract_hash: str, memory_lines: Optional[list[str]] = None, is_train: bool = True,
    max_public_feedback_cap: int = 2000, non_authoritative: bool = True,
    task_family: Optional[str] = None, forbidden_values: Optional[list[str]] = None,
) -> dict:
    os.makedirs(work_dir, exist_ok=True)
    task_trace: list[str] = []
    bank_before = "empty"

    # (0) DEFECT-5 fail-closed FAMILY BINDING — runs BEFORE any reservation / messages.create. The
    # authoritative family is the one the frozen family map bound into the context. It must be a
    # non-empty member of the frozen taxonomy AND agree across every component that will see it
    # (an optional caller override, and the grant if the grant carries a binding). Any empty / null /
    # unknown / mismatched family raises TaskFamilyBindingError here → no reservation, no model call,
    # no write-gate, no bank mutation, no curriculum advancement (an APPARATUS/INFRA failure).
    bound_family = assert_task_family_valid(ctx.task_family)
    if task_family is not None and task_family != bound_family:
        raise TaskFamilyBindingError(
            f"caller task_family {task_family!r} != frozen context family {bound_family!r} for "
            f"{ctx.task_id} — mismatch across components (blocked before reservation)")
    grant_family = getattr(grant, "task_family", "") or ""
    if grant_family and grant_family != bound_family:
        raise TaskFamilyBindingError(
            f"grant task_family {grant_family!r} != frozen context family {bound_family!r} for "
            f"{ctx.task_id} — grant/task metadata mismatch (blocked before reservation)")

    budget = BudgetLedger(os.path.join(work_dir, "ledger.json"), total_budget=fold_budget_usd)
    journal = CallJournal(os.path.join(work_dir, "journal.jsonl"))
    grant_ledger = GrantUsageLedger(grant_ledger_path)
    task_res_id = f"task:{ctx.task_id}"

    # (1) ONE atomic task-level reservation of the full R1+R2 max exposure BEFORE any send.
    budget.reserve(task_res_id, float(Decimal(full_exposure_usd)))
    task_trace.append(TASK_RESERVED)

    solver = ModelBackedRoundSolver(
        client=client, statement=statement, allowed_source_files=list(ctx.allowed_source_files),
        task_family=bound_family, is_train=is_train, pricing=pricing, endpoint_att=endpoint_att,
        ledger=budget, journal=journal, fold=grant.fold, condition=grant.condition,
        context_cap=context_cap, count_fn=count_fn, run_id=f"canary:{ctx.task_id}", env_hash=env_hash,
        contract_hash=contract_hash, active_bank_hash=bank_before, task_id=ctx.task_id,
        execution_grant=grant, grant_ledger=grant_ledger, task_reservation=True)

    public_statuses: list[str] = []
    round1_status: Optional[str] = None
    round2_opened = False
    candidates = []
    feedback: Optional[str] = None
    classifications: list[Optional[str]] = []
    patch_statuses: list[Optional[str]] = []
    patch_applied = False                                # hidden verify runs ONLY if this is True

    for round_index in (1, 2):
        if round_index == 2:
            # R2 opens ONLY after a LEGITIMATE public FAIL (a complete+valid+applied patch that then
            # failed the public suite) — never after truncation/malformed/refusal/apply-failure.
            if round1_status != "FAIL":
                break
            round2_opened = True
        view = RoundView(round_index=round_index, task_id=ctx.task_id, task_family=bound_family,
                         source=dict(ctx.buggy_source), public_tests={},
                         memory_lines=list(memory_lines or []), public_feedback=feedback)
        try:
            out = solver.solve_round(view)               # ONLY this can raise transport ambiguity
        except Exception:                                # CALL_AMBIGUOUS_AFTER_SEND (reservation held)
            task_trace.append(AMBIGUOUS_HELD)
            # reservation intentionally RETAINED; grant NOT completed; no R2; no auto-retry.
            return _report(ctx, grant, grant_ledger, budget, journal, task_res_id, full_exposure_usd,
                           task_trace, public_statuses, round2_opened, hidden_verdict=None,
                           write_written=0, bank_before=bank_before, bank_after=bank_before,
                           calls=solver.calls, ambiguous=True, reconciled=False, completed=False,
                           classifications=classifications, patch_statuses=patch_statuses,
                           hidden_count=0)
        classifications.append(out.classification)

        # FAIL-CLOSED (Decision A + defect-3): only a COMPLETE + VALID reply is applied and graded.
        # Truncated / malformed / refusal → TERMINAL solver failure: no apply, no public grading,
        # no R2, no hidden verify, no write-gate, no bank mutation, no auto-retry.
        if not is_official_pass_eligible(out.classification):
            outcome = (SOLVER_FAIL_TRUNCATED if out.classification == TRUNCATED_OUTPUT
                       else f"SOLVER_FAIL_{out.classification}")
            patch_statuses.append(None)
            public_statuses.append(outcome)
            if round_index == 1:
                round1_status = outcome
            break

        # VALID: apply the patch against the buggy pre-image. An apply failure (NOT_FOUND / AMBIGUOUS
        # / OVERLAP) is a TERMINAL solver failure too — no public grading, no R2, no hidden verify.
        try:
            RT.apply_patch(ctx, out.sr_edits)            # exact SEARCH/REPLACE vs the buggy pre-image
            patch_applied = True
            patch_statuses.append("APPLIED")
        except (PatchFormatError, ValueError) as exc:    # solver failure — NOT a transport ambiguity
            patch_statuses.append(getattr(exc, "code", "PATCH_APPLY_FAILED"))
            public_statuses.append("SOLVER_FAIL_PATCH_APPLY")
            if round_index == 1:
                round1_status = "SOLVER_FAIL_PATCH_APPLY"
            break
        if is_train and grant.condition == "C" and out.candidate_lesson is not None:
            candidates.append(out.candidate_lesson)
        pub = RT.run_public_tests(ctx)                   # repo-backed, unshare -rn, 4-state
        public_statuses.append(pub.status)
        if round_index == 1:
            round1_status = pub.status
        if pub.status != "FAIL":
            break
        feedback = pub.sanitized_summary[:max_public_feedback_cap]

    # (2) hidden verify runs ONCE, and ONLY when a valid patch was actually applied (defect-3): a
    # hidden verdict on unchanged/buggy source is not a signal about the model's solution.
    if patch_applied:
        hidden_verdict = RT.hidden_verify(ctx)           # verdict never fed back to the model
        hidden_count = 1
        task_trace.append(HIDDEN_VERIFY)
    else:
        hidden_verdict = None
        hidden_count = 0

    # (3) write-gate on any candidate lesson — ONLY when a patch was applied (no bank mutation on a
    # failed/unapplied attempt). Candidates are only collected on a VALID+applied round anyway.
    # Reference-fix leakage screen (defect fix): the FROZEN, provenance-aware forbidden-token set for
    # THIS task (new fix-only identifiers, non-public, corpus-unique) — NOT every word in the fix file.
    if forbidden_values is not None:
        forbidden = forbidden_values
    else:
        corpus_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.dirname(os.path.abspath(__file__)))))), "corpus")
        forbidden = load_frozen_forbidden_tokens(corpus_dir).for_task(ctx.task_id)
    written = []
    if patch_applied:
        for cand in candidates:
            # DEFECT-5: the AUTHORITATIVE task family (frozen map), never the candidate's self-label —
            # the write-gate's own check #6 (candidate.task_family == task_family) is only meaningful
            # when ``task_family`` is the independent, authoritative binding.
            res = evaluate_write_gate(cand, is_train=is_train, verifier_passed=hidden_verdict,
                                      task_family=bound_family, existing=written,
                                      forbidden_values=forbidden)
            if res.written:
                written.append(cand)
    task_trace.append(WRITE_GATE)
    bank_after = f"bank+{len(written)}" if written else bank_before

    # (4) reconcile the ONE task reservation with the real total cost; release the unused remainder
    total_actual = float(sum(Decimal(str(c["actual_cost_usd"])) for c in solver.calls))
    budget.reconcile(task_res_id, total_actual)
    task_trace.append(RECONCILED)

    # (5) seal the grant complete (non-replayable) + close the task
    grant_ledger.mark_complete(grant)
    task_trace.extend([GRANT_COMPLETED, TASK_CLOSED])
    return _report(ctx, grant, grant_ledger, budget, journal, task_res_id, full_exposure_usd,
                   task_trace, public_statuses, round2_opened, hidden_verdict, len(written),
                   bank_before, bank_after, solver.calls, classifications=classifications,
                   patch_statuses=patch_statuses, hidden_count=hidden_count, ambiguous=False,
                   reconciled=True,
                   completed=True)


def _report(ctx, grant, grant_ledger, budget, journal, task_res_id, full_exposure_usd, task_trace,
            public_statuses, round2_opened, hidden_verdict, write_written, bank_before, bank_after,
            calls, *, ambiguous, reconciled, completed, classifications=None,
            patch_statuses=None, hidden_count=0) -> dict:
    per_call = [{"round": c["round"], "input_tokens": c["input_tokens"],
                 "output_tokens": c["output_tokens"], "actual_cost_usd": c["actual_cost_usd"]}
                for c in calls]
    total_actual = float(sum(Decimal(str(c["actual_cost_usd"])) for c in calls))
    call_ids: list[str] = []
    if os.path.exists(journal.path):
        for line in open(journal.path).read().splitlines():
            if line.strip():
                cid = json.loads(line)["call_id"]
                if cid not in call_ids:
                    call_ids.append(cid)
    journal_terminals = {cid: classify_journal_terminal(journal.states_for(cid)) for cid in call_ids}
    return {
        "task_id": ctx.task_id, "task_family": ctx.task_family,
        "task_trace": task_trace, "public_statuses": public_statuses,
        "round2_opened": round2_opened, "hidden_verdict": hidden_verdict,
        "per_call": per_call, "calls_sent": len(calls),
        "reserved_usd": full_exposure_usd, "reconciled_usd": (f"{total_actual:.8f}" if reconciled else None),
        "budget_available_after": budget.available(),
        "journal_terminals": journal_terminals,
        "write_gate_written": write_written, "bank_hash_before": bank_before,
        "bank_hash_after": bank_after,
        "grant_calls_used": grant_ledger.calls_used(grant.grant_id),
        "grant_calls_remaining": grant.max_messages_calls - grant_ledger.calls_used(grant.grant_id),
        "grant_completed": grant_ledger.is_completed(grant.grant_id),
        "ambiguous_held": ambiguous, "task_2_started": False,
        "network_isolation": " ".join(ctx.netns()),
        "round_classifications": list(classifications or []),
        "patch_statuses": list(patch_statuses or []),
        "hidden_verify_count": hidden_count,
        "patch_applied": hidden_count > 0,
    }
