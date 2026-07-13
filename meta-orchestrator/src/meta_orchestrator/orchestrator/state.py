"""LangGraph state for a single seed-task run.

Objects (BugCase, VerifyResult, ledger, callables) are carried directly; the Phase 1
graph runs in-memory (no serialising checkpointer), so this is safe. A durable
Postgres checkpointer (SPEC §1) is a later concern.
"""
from __future__ import annotations

from typing import Any, Callable, Optional, TypedDict


class OrchestratorState(TypedDict, total=False):
    run_id: str
    case: Any                       # BugCase
    approver: Optional[Callable[[str, dict], bool]]
    ledger: Any                     # BudgetLedger

    classification: Any             # TaskClassification
    playbook_tier1: Optional[dict]
    plan: Any                       # Plan

    tried_models: list[str]
    selected_model: Optional[str]
    selected_p_success: float

    candidate_source: Optional[str]
    verify_result: Any              # VerifyResult (execution self-check)
    synthesis: Optional[dict]       # {"artifact", "summary", "model"}
    final_verify: Any               # VerifyResult (independent verifier)

    postmortem: Optional[dict]
    decision_records: list          # list[DecisionRecord]
    trace: list                     # list[dict]  (ReAct / node events)
    status: str
    cost: float
