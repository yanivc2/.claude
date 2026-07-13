"""The single-agent LangGraph orchestrator (SPEC §1, Milestone C).

Wires the learning backbone (Milestone B) into a runnable graph:

  classify → read_memory → plan → select_model → execute → verify
      → (retry ↺ select_model | synthesize) → independent_verify → postmortem

Every choice goes through the Decision Engine (SPEC §16.5). The synthesizer is a single
model (coherent output, §0.5). The independent verifier CHECKS the final artifact — it
never rewrites it (§1). The post-mortem updates memory per the outcome (§5.7).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from langgraph.graph import END, START, StateGraph

from ..autonomy.budget import BudgetLedger
from ..autonomy.policy import AutonomyController, AutonomyMode
from ..config import OrchestratorConfig
from ..decision.engine import DecisionEngine, build_model_options
from ..gateway.adapters import make_adapter
from ..gateway.gateway import ModelGateway
from ..learning.bandit import BanditBook
from ..memory.reader import PlaybookReader
from ..memory.writer import MemoryWriter
from ..models import DecisionRecord, FailureCategory, VerifyResult
from ..observability.tracing import RunMetrics, build_metrics
from ..persistence.store import Store
from ..planner.planner import plan_seed_task, topological_levels
from ..postmortem import PostMortem
from ..registry.registry import ModelRegistry
from ..seed_task.definition import BugCase
from ..taxonomy import SEED_TASK_TYPE, classify_seed_task
from ..tools.gateway import default_tool_gateway
from ..utils import now_iso
from ..verification.code_verifier import verify_code_fix
from .state import OrchestratorState

Approver = Callable[[str, dict], bool]


@dataclass
class RunOutcome:
    run_id: str
    correlation_id: str
    passed: bool
    status: str
    selected_model: Optional[str]
    rounds: int
    cost: float
    tokens_spent: int
    postmortem: dict
    playbook_key: str
    decision_records: list
    trace: list
    metrics: Optional[RunMetrics] = None


class Orchestrator:
    def __init__(self, store: Store, registry: ModelRegistry, config: OrchestratorConfig) -> None:
        self.store = store
        self.registry = registry
        self.config = config
        self.bandit = BanditBook(store)
        self.engine = DecisionEngine(config.decision_weights)
        self.gateway = ModelGateway(registry, make_adapter(config.model_adapter))
        self.tools = default_tool_gateway()
        self.writer = MemoryWriter(store)
        self.reader = PlaybookReader(store)
        self.postmortem = PostMortem(self.writer)
        self.controller = AutonomyController(config.autonomy_mode)
        self._graph = self._build()

    # --- graph construction ---
    def _build(self):
        g = StateGraph(OrchestratorState)
        g.add_node("classify", self._classify)
        g.add_node("read_memory", self._read_memory)
        g.add_node("plan", self._plan)
        g.add_node("gate", self._gate)
        g.add_node("select_model", self._select_model)
        g.add_node("execute", self._execute)
        g.add_node("verify", self._verify)
        g.add_node("synthesize", self._synthesize)
        g.add_node("independent_verify", self._independent_verify)
        g.add_node("postmortem", self._postmortem)
        g.add_node("abort", self._abort)

        g.add_edge(START, "classify")
        g.add_edge("classify", "read_memory")
        g.add_edge("read_memory", "plan")
        g.add_edge("plan", "gate")
        # Autonomy + budget circuit breaker gate (D1).
        g.add_conditional_edges(
            "gate", self._route_after_gate,
            {"proceed": "select_model", "abort": "abort"},
        )
        g.add_edge("select_model", "execute")
        g.add_edge("execute", "verify")
        g.add_conditional_edges(
            "verify", self._route_after_verify,
            {"retry": "select_model", "synthesize": "synthesize"},
        )
        g.add_edge("synthesize", "independent_verify")
        g.add_edge("independent_verify", "postmortem")
        g.add_edge("postmortem", END)
        g.add_edge("abort", END)
        return g.compile()

    # --- helpers ---
    @staticmethod
    def _traced(state: OrchestratorState, event: dict) -> list:
        # Every span carries the correlation id (SPEC §15).
        return list(state.get("trace", [])) + [
            {"at": now_iso(), "corr": state.get("correlation_id"), **event}
        ]

    def _task_type(self, state: OrchestratorState) -> str:
        c = state["classification"]
        return c.labels[-1] if c.labels else SEED_TASK_TYPE

    def _max_price(self) -> float:
        return max((m.price_per_1k_out for m in self.registry.candidate_models(SEED_TASK_TYPE)),
                   default=0.015)

    @staticmethod
    def _estimate_tokens(case: BugCase) -> int:
        # Rough pre-flight estimate for one round (generate + synthesize).
        return (len(case.module_source) + len(case.test_source)) // 4 + 40

    # --- nodes ---
    def _classify(self, state: OrchestratorState) -> dict:
        # Provisional classification (SPEC §8: reversible best-guess).
        classification = classify_seed_task()
        return {
            "classification": classification,
            "tried_models": [],
            "cost": 0.0,
            "status": "running",
            "aborted": False,
            "trace": self._traced(state, {"node": "classify", "labels": classification.labels}),
        }

    def _read_memory(self, state: OrchestratorState) -> dict:
        key = state["classification"].playbook_key()
        tier1 = self.reader.read_tier1(key)  # compact Tier-1 read (B5)
        return {
            "playbook_tier1": tier1,
            "trace": self._traced(state, {"node": "read_memory", "playbook": tier1}),
        }

    def _plan(self, state: OrchestratorState) -> dict:
        plan = plan_seed_task(state["case"])
        levels = topological_levels(plan)
        return {
            "plan": plan,
            "trace": self._traced(state, {"node": "plan", "levels": levels}),
        }

    def _gate(self, state: OrchestratorState) -> dict:
        """Autonomy + hard budget circuit breaker before any paid work (D1)."""
        case: BugCase = state["case"]
        ledger: BudgetLedger = state["ledger"]
        approver = state.get("approver")
        est_tokens = self._estimate_tokens(case)
        est_cost = est_tokens / 1000.0 * self._max_price()

        # Hard budget ceiling (circuit breaker) — enforced in every mode.
        if not ledger.can_afford(est_tokens):
            return self._abort_update(state, "aborted_budget",
                                      f"budget {ledger.remaining()} < est {est_tokens} tokens")
        # Autonomy mode gate (may pause for approval; switchable mid-run).
        proceed, reason = self.controller.gate(est_cost=est_cost, approver=approver)
        if not proceed:
            status = "aborted_plan" if self.controller.mode is AutonomyMode.PLAN_FIRST else "aborted_cost"
            return self._abort_update(state, status, reason)
        return {"trace": self._traced(state, {"node": "gate", "mode": self.controller.mode.value,
                                              "est_tokens": est_tokens, "reason": reason})}

    def _abort_update(self, state: OrchestratorState, status: str, reason: str) -> dict:
        return {
            "aborted": True,
            "status": status,
            "trace": self._traced(state, {"node": "gate", "aborted": True,
                                          "status": status, "reason": reason}),
        }

    def _route_after_gate(self, state: OrchestratorState) -> str:
        return "abort" if state.get("aborted") else "proceed"

    def _abort(self, state: OrchestratorState) -> dict:
        """Terminal node for an aborted run: produce the minimal shape run() expects."""
        status = state.get("status", "aborted")
        fv = VerifyResult(passed=False, confidence=1.0, evidence=[f"run {status}"],
                          blocking=True, failure_category=FailureCategory.NONE)
        pm = {
            "aborted": True, "reason": status, "actual_passed": False,
            "predicted_p_success": state.get("selected_p_success", 0.0), "calibration_gap": 0.0,
            "failure_category": "none", "update_action": "none",
            "root_cause": status, "playbook_updated": False,
        }
        return {
            "final_verify": fv, "postmortem": pm,
            "trace": self._traced(state, {"node": "abort", "status": status}),
        }

    def _select_model(self, state: OrchestratorState) -> dict:
        task_type = self._task_type(state)
        tried = list(state.get("tried_models", []))
        ledger: BudgetLedger = state["ledger"]
        ledger.rounds += 1

        candidates = self.registry.candidate_models(task_type)
        untried = [m for m in candidates if m.model_id not in tried] or candidates
        p = {
            m.model_id: self.bandit.estimate(task_type, m.model_id,
                                             prior_score=self.registry.prior_score(m.model_id, task_type))
            for m in untried
        }
        options = build_model_options(untried, p)
        winner, _scored, record = self.engine.decide(
            options, run_id=state["run_id"], node="select_model",
            budget_remaining=ledger.remaining(),
        )
        self.store.add_decision_record(record)
        tried.append(winner.option.label)
        return {
            "selected_model": winner.option.label,
            "selected_p_success": winner.option.p_success,
            "tried_models": tried,
            "decision_records": list(state.get("decision_records", [])) + [record],
            "trace": self._traced(state, {"node": "select_model", "chosen": winner.option.label,
                                          "utility": round(winner.utility, 4)}),
        }

    def _execute(self, state: OrchestratorState) -> dict:
        """Run the task graph in topological order; generate step calls the model gateway."""
        plan = state["plan"]
        case: BugCase = state["case"]
        ledger: BudgetLedger = state["ledger"]
        trace = list(state.get("trace", []))
        corr = state.get("correlation_id")
        candidate_source = state.get("candidate_source")
        cost = state.get("cost", 0.0)

        for level in topological_levels(plan):
            for sid in level:
                sub = plan.by_id(sid)
                if sub.kind == "analyze":
                    trace = trace + [{"at": now_iso(), "corr": corr, "node": "execute",
                                      "react": "reason→read", "subtask": sid, "obs": sub.description}]
                elif sub.kind == "generate":
                    result = self.gateway.run(state["selected_model"],
                                              {"kind": "code_fix", "case": case})
                    candidate_source = result.response.content["candidate_source"]
                    ledger.charge(result.tokens)
                    cost += result.cost
                    trace = trace + [{"at": now_iso(), "corr": corr, "node": "execute",
                                      "react": "reason→act", "subtask": sid,
                                      "model": result.model_used, "tokens": result.tokens}]
                # 'verify' subtask is executed by the dedicated verify node.
        return {"candidate_source": candidate_source, "cost": cost, "trace": trace}

    def _verify(self, state: OrchestratorState) -> dict:
        """Execution self-check via the Tool Gateway (LOW tier), and per-attempt learning."""
        case: BugCase = state["case"]
        task_type = self._task_type(state)
        res = self.tools.invoke(
            "run_tests",
            {"case": case, "candidate_source": state["candidate_source"]},
            approver=state.get("approver"),
        )
        # Per-attempt bandit update (B3) — so a retry can re-route on fresh evidence.
        prior = self.registry.prior_score(state["selected_model"], task_type)
        self.bandit.update(task_type, state["selected_model"], success=res.passed, prior_score=prior)
        return {
            "verify_result": res,
            "trace": self._traced(state, {"node": "verify", "passed": res.passed,
                                          "category": res.failure_category.value}),
        }

    def _route_after_verify(self, state: OrchestratorState) -> str:
        res = state["verify_result"]
        if res.passed:
            return "synthesize"
        ledger: BudgetLedger = state["ledger"]
        candidates = self.registry.candidate_models(self._task_type(state))
        untried = [m for m in candidates if m.model_id not in state.get("tried_models", [])]
        # Bounded retry (circuit breaker): only if a fresh candidate + budget + rounds remain.
        if untried and ledger.rounds < ledger.max_rounds and ledger.can_afford(200):
            return "retry"
        return "synthesize"

    def _synthesize(self, state: OrchestratorState) -> dict:
        """Single synthesizer → coherent final artifact (SPEC §0.5, C4)."""
        ledger: BudgetLedger = state["ledger"]
        result = self.gateway.run(
            state["selected_model"],
            {"kind": "synthesize", "candidate_source": state["candidate_source"]},
        )
        ledger.charge(result.tokens)
        synthesis = {
            "artifact": result.response.content["artifact"],
            "summary": result.response.content.get("summary", ""),
            "model": result.model_used,
        }
        return {
            "synthesis": synthesis,
            "cost": state.get("cost", 0.0) + result.cost,
            "trace": self._traced(state, {"node": "synthesize", "model": result.model_used}),
        }

    def _independent_verify(self, state: OrchestratorState) -> dict:
        """Independent verifier: re-check the FINAL artifact; checks only, never rewrites (C5)."""
        case: BugCase = state["case"]
        res = verify_code_fix(case, state["synthesis"]["artifact"])
        return {
            "final_verify": res,
            "trace": self._traced(state, {"node": "independent_verify", "passed": res.passed,
                                          "blocking": res.blocking}),
        }

    def _postmortem(self, state: OrchestratorState) -> dict:
        pm = self.postmortem.analyze(
            classification=state["classification"],
            selected_model=state["selected_model"],
            predicted_p_success=state.get("selected_p_success", 0.5),
            final_verify=state["final_verify"],
            bandit=self.bandit,
            cost=state.get("cost", 0.0),
        )
        record = DecisionRecord(
            run_id=state["run_id"], node="postmortem", chosen=state["selected_model"],
            utility=pm["predicted_p_success"], reason=pm["root_cause"], created_at=now_iso(),
        )
        self.store.add_decision_record(record)
        status = "completed" if state["final_verify"].passed else "blocked"
        return {
            "postmortem": pm,
            "status": status,
            "decision_records": list(state.get("decision_records", [])) + [record],
            "trace": self._traced(state, {"node": "postmortem", "status": status, **pm}),
        }

    # --- public API ---
    def run(self, case: BugCase, *, run_id: str, approver: Optional[Approver] = None,
            ledger: Optional[BudgetLedger] = None,
            correlation_id: Optional[str] = None) -> RunOutcome:
        ledger = ledger or BudgetLedger(self.config.budget_tokens, self.config.max_rounds)
        corr = correlation_id or run_id
        init: OrchestratorState = {
            "run_id": run_id, "correlation_id": corr, "case": case, "approver": approver,
            "ledger": ledger, "trace": [], "decision_records": [],
        }
        final: dict[str, Any] = self._graph.invoke(init)
        outcome = RunOutcome(
            run_id=run_id,
            correlation_id=corr,
            passed=final["final_verify"].passed,
            status=final.get("status", "unknown"),
            selected_model=final.get("selected_model"),
            rounds=ledger.rounds,
            cost=round(final.get("cost", 0.0), 6),
            tokens_spent=ledger.spent_tokens,
            postmortem=final["postmortem"],
            playbook_key=final["classification"].playbook_key(),
            decision_records=final.get("decision_records", []),
            trace=final.get("trace", []),
        )
        outcome.metrics = build_metrics(outcome)
        return outcome
