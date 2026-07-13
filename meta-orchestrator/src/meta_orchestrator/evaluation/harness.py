"""Eval harness (SPEC §15, D3).

Runs the seed corpus repeatedly through the orchestrator (which shares one Store, so
learning accumulates) and measures whether the system **improves across runs** — the
Phase 1 success criterion. Reports both quality (success rate) and operational metrics
(rounds, cost), plus convergence of the Decision Engine's first choice and the growth
of playbook confidence.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from ..autonomy.budget import BudgetLedger
from ..taxonomy import SEED_TASK_TYPE


class RunRecord(BaseModel):
    run_id: str
    bug_id: str
    passed: bool
    first_choice: Optional[str]
    rounds: int
    cost: float
    playbook_confidence: float


class EvalReport(BaseModel):
    n_runs: int
    success_rate: float
    early_success_rate: float
    late_success_rate: float
    early_avg_rounds: float
    late_avg_rounds: float
    first_choice_trend: list[str] = Field(default_factory=list)
    playbook_confidence_trend: list[float] = Field(default_factory=list)
    bandit_means_final: dict[str, float] = Field(default_factory=dict)
    best_model_final: Optional[str]
    converged: bool
    confidence_increased: bool
    improved: bool
    phase1_pass: bool
    records: list[RunRecord] = Field(default_factory=list)

    def summary(self) -> str:
        return (
            f"runs={self.n_runs} success={self.success_rate:.2f} "
            f"(early={self.early_success_rate:.2f}→late={self.late_success_rate:.2f}) "
            f"rounds(early→late)={self.early_avg_rounds:.2f}→{self.late_avg_rounds:.2f} "
            f"best={self.best_model_final} converged={self.converged} "
            f"conf↑={self.confidence_increased} PHASE1_PASS={self.phase1_pass}"
        )


class EvalHarness:
    def __init__(self, orch, converge_window: int = 3) -> None:
        self.orch = orch
        self.converge_window = converge_window

    def run(self, cases, repeats: int, run_prefix: str = "eval") -> EvalReport:
        records: list[RunRecord] = []
        idx = 0
        for _ in range(repeats):
            for case in cases:
                run_id = f"{run_prefix}-{idx}"
                ledger = BudgetLedger(self.orch.config.budget_tokens, self.orch.config.max_rounds)
                out = self.orch.run(case, run_id=run_id, ledger=ledger)
                first_choice = out.decision_records[0].chosen if out.decision_records else out.selected_model
                t1 = self.orch.reader.read_tier1(out.playbook_key)
                records.append(RunRecord(
                    run_id=run_id, bug_id=case.bug_id, passed=out.passed,
                    first_choice=first_choice, rounds=out.rounds, cost=out.cost,
                    playbook_confidence=(t1 or {}).get("confidence", 0.0),
                ))
                idx += 1
        return self._report(records)

    def _report(self, records: list[RunRecord]) -> EvalReport:
        n = len(records)
        w = max(1, n // 3)
        early, late = records[:w], records[-w:]

        def rate(rs) -> float:
            return sum(r.passed for r in rs) / len(rs) if rs else 0.0

        def avg_rounds(rs) -> float:
            return sum(r.rounds for r in rs) / len(rs) if rs else 0.0

        means = {
            m.model_id: round(self.orch.bandit.estimate(SEED_TASK_TYPE, m.model_id), 4)
            for m in self.orch.registry.candidate_models(SEED_TASK_TYPE)
        }
        best_model = max(means, key=means.get) if means else None

        first_choices = [r.first_choice for r in records]
        last_choices = first_choices[-self.converge_window:]
        converged = len(last_choices) >= self.converge_window and len(set(last_choices)) == 1

        conf_trend = [r.playbook_confidence for r in records]
        confidence_increased = conf_trend[-1] > conf_trend[0] if conf_trend else False

        early_sr, late_sr = rate(early), rate(late)
        early_ar, late_ar = avg_rounds(early), avg_rounds(late)
        improved = (late_sr > early_sr + 1e-9) or (late_ar < early_ar - 1e-9)

        phase1_pass = bool(converged and confidence_increased and late_sr >= 0.9 and improved)

        return EvalReport(
            n_runs=n,
            success_rate=rate(records),
            early_success_rate=early_sr, late_success_rate=late_sr,
            early_avg_rounds=early_ar, late_avg_rounds=late_ar,
            first_choice_trend=first_choices,
            playbook_confidence_trend=conf_trend,
            bandit_means_final=means, best_model_final=best_model,
            converged=converged, confidence_increased=confidence_increased,
            improved=improved, phase1_pass=phase1_pass, records=records,
        )
