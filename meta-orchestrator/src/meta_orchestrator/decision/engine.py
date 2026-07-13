"""Decision / Utility Engine v1 (SPEC §4, B6).

Every choice point (which model, whether to consult, when to stop, ...) is scored by
ONE utility function so principles don't conflict. Phase 1 uses the lean 3-term form:

    Utility = w_success · P(success) − w_cost · cost − w_risk · risk

subject to a hard budget ceiling (SPEC §9/§10). Extra terms (quality, evidence,
user-fit, uncertainty) are added in later phases without changing callers.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from ..models import DecisionRecord, ModelSpec
from ..utils import now_iso


class Option(BaseModel):
    """One candidate choice, with the signals the utility function needs."""

    label: str
    p_success: float                 # from bandit posterior (SPEC §6)
    cost: float = 0.0                # normalised 0..1 relative cost
    risk: float = 0.0                # 0..1
    est_tokens: int = 0              # for the budget ceiling
    payload: dict = Field(default_factory=dict)


class ScoredOption(BaseModel):
    option: Option
    utility: float


class BudgetExceededError(RuntimeError):
    """No option fits within the remaining budget (circuit breaker, SPEC §10)."""


class DecisionEngine:
    def __init__(self, weights: dict[str, float]) -> None:
        self.w_success = weights.get("w_success", 1.0)
        self.w_cost = weights.get("w_cost", 0.15)
        self.w_risk = weights.get("w_risk", 0.30)

    def score(self, opt: Option) -> float:
        return (
            self.w_success * opt.p_success
            - self.w_cost * opt.cost
            - self.w_risk * opt.risk
        )

    def decide(
        self,
        options: list[Option],
        *,
        run_id: str,
        node: str,
        budget_remaining: Optional[int] = None,
    ) -> tuple[ScoredOption, list[ScoredOption], DecisionRecord]:
        """Pick the highest-utility option that fits the budget ceiling.

        Returns (winner, all_scored_desc, decision_record). The record documents WHY
        (SPEC §5.8): chosen label, utility, and the scored alternatives.
        """
        if not options:
            raise ValueError("decide() requires at least one option")

        affordable = [
            o for o in options
            if budget_remaining is None or o.est_tokens <= budget_remaining
        ]
        if not affordable:
            raise BudgetExceededError(
                f"node={node!r}: all {len(options)} options exceed budget_remaining={budget_remaining}"
            )

        scored = sorted(
            (ScoredOption(option=o, utility=self.score(o)) for o in affordable),
            key=lambda s: s.utility,
            reverse=True,
        )
        winner = scored[0]
        record = DecisionRecord(
            run_id=run_id,
            node=node,
            chosen=winner.option.label,
            utility=winner.utility,
            alternatives=[{"label": s.option.label, "utility": round(s.utility, 6)} for s in scored],
            reason=(
                f"max utility {winner.utility:.4f} = "
                f"{self.w_success}*P({winner.option.p_success:.3f}) "
                f"- {self.w_cost}*cost({winner.option.cost:.3f}) "
                f"- {self.w_risk}*risk({winner.option.risk:.3f})"
            ),
            created_at=now_iso(),
        )
        return winner, scored, record


def build_model_options(
    candidates: list[ModelSpec],
    p_success: dict[str, float],
    *,
    est_tokens: int = 0,
) -> list[Option]:
    """Turn Registry candidates into Decision-Engine options.

    ``p_success`` comes from the bandit (per model). Cost is normalised against the
    most expensive candidate so it is comparable to the 0..1 success probability.
    """
    prices = {m.model_id: m.price_per_1k_out for m in candidates}
    max_price = max(prices.values()) or 1.0
    opts: list[Option] = []
    for m in candidates:
        opts.append(
            Option(
                label=m.model_id,
                p_success=p_success.get(m.model_id, 0.5),
                cost=prices[m.model_id] / max_price,
                risk=0.0 if m.availability else 1.0,
                est_tokens=est_tokens,
                payload={"provider": m.provider},
            )
        )
    return opts
