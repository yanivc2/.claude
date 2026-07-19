"""Canonical fold cost projection (single source of truth for Gate-1 budget evidence).

The consultation flagged that hand-assembling ``BudgetEvidence.projected_fold_cost`` from
per-run typed-in assumptions produces a Gate that is irreproducible and drifts between operators.
This module freezes ONE projection so every projection, reserve, maximum-single-call exposure and
fold/global cap is derived from (a) the frozen ``PricingArtifact`` and (b) the REAL per-request
``count_tokens`` inputs — never from a local rate or a statistical guess.

The GATE-BINDING figure is a strict worst case that does NOT depend on a Round-2-rate estimate:

    Round-2 rate            = 100%  (every task incurs both an R1 and an R2 call)
    Output per call         = full max_tokens (thinking billed as output)
    Input per call          = the REAL anthropic_count_tokens for that canonical R1 / R2 request
    Reserve fraction        = 25%

        fold_worst              = Σ full_cost(R1_i) + Σ full_cost(R2_i)
        fold_worst_with_reserve = fold_worst × (1 + reserve_fraction)      # PASS/FAIL binds here

``planning_scenario`` figures (0% / 50% / 100% Round-2, with explicit output utilisation) are
reported for context ONLY. Nothing here is called "expected": that label requires a frozen
assumptions artifact backed by real usage data, which does not exist pre-canary. All money is
``Decimal`` (via ``pricing.call_cost_usd``); floats appear only at the ``BudgetEvidence`` boundary.
"""
from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, Field

from .contract_s2 import S2_MAX_TOKENS
from .evidence import BudgetEvidence
from .pricing import PricingArtifact, call_cost_usd, max_call_cost_usd

# Frozen gate assumptions (the strict worst case that determines PASS / FAIL).
GATE_ROUND2_RATE = Decimal("1.00")            # 100% of tasks reach Round 2
GATE_OUTPUT_TOKENS_PER_CALL = S2_MAX_TOKENS   # full max_tokens billed as output (thinking incl.)
GATE_RESERVE_FRACTION = Decimal("0.25")       # >= 20-25% reserve (runbook)

# Whole-experiment call structure (frozen; used ONLY for the global-cap worst case). In 3-fold CV
# each task is a TRAIN task in exactly 2 folds (C-training R1+R2) and a HELD-OUT task in exactly 1
# fold. A held-out task runs 6 condition-runs — primary A/C/D/B1 + stability A/C — each R1+R2 worst
# case. So the per-task worst (R1+R2 full output) is billed 2× (train) + 6× (held-out) = 8×.
TRAIN_FOLDS_PER_TASK = 2
HELDOUT_CONDITION_RUNS_PER_TASK = 6
EXPERIMENT_WORST_MULTIPLIER = TRAIN_FOLDS_PER_TASK + HELDOUT_CONDITION_RUNS_PER_TASK  # = 8


def _d(x: Decimal) -> str:
    return format(x, "f")


class PlanningScenario(BaseModel):
    """A transparency-only projection (NOT gate-binding). Explicit Round-2 rate + output use."""

    label: str
    round2_rate: str                          # Decimal as string, e.g. "0.50"
    output_utilisation: str                   # fraction of max_tokens assumed as output
    output_tokens_per_call: int
    projected_cost_usd: str


class FoldCostProjection(BaseModel):
    """The single, reproducible cost projection for one fold. ``worst_*`` binds Gate 1."""

    fold: int
    n_tasks: int
    max_output_tokens: int = S2_MAX_TOKENS

    # real per-request inputs (anthropic_count_tokens), one entry per task, in curriculum order.
    r1_input_tokens: list[int]
    r2_input_tokens: list[int]

    # gate-binding worst case
    gate_round2_rate: str = _d(GATE_ROUND2_RATE)
    reserve_fraction: str = _d(GATE_RESERVE_FRACTION)
    worst_fold_cost_usd: str
    worst_fold_cost_with_reserve_usd: str
    max_single_call_exposure_usd: str

    # transparency-only
    planning_scenarios: list[PlanningScenario] = Field(default_factory=list)

    def fits_budget(self, available_budget_usd: str | float) -> bool:
        """PASS/FAIL rule: worst-case + reserve must fit the available budget."""
        return Decimal(self.worst_fold_cost_with_reserve_usd) <= Decimal(str(available_budget_usd))

    def to_budget_evidence(self, available_budget_usd: str | float) -> BudgetEvidence:
        """The gate consumes the WORST-CASE fold cost; verify_budget_evidence re-applies the
        reserve (need = projected × (1 + reserve)), so this reproduces worst × 1.25 exactly."""
        return BudgetEvidence(
            projected_fold_cost=float(Decimal(self.worst_fold_cost_usd)),
            reserve_fraction=float(Decimal(self.reserve_fraction)),
            available_budget=float(Decimal(str(available_budget_usd))))


def _full_cost(pricing: PricingArtifact, input_tokens: int, output_tokens: int) -> Decimal:
    return call_cost_usd(pricing, input_tokens=input_tokens, output_tokens=output_tokens)


def _planning(pricing: PricingArtifact, *, label: str, round2_rate: Decimal,
              output_utilisation: Decimal, r1: list[int], r2: list[int]) -> PlanningScenario:
    out_tokens = int((output_utilisation * Decimal(S2_MAX_TOKENS)).to_integral_value())
    total = Decimal(0)
    for tok in r1:                                        # every task makes an R1 call
        total += _full_cost(pricing, tok, out_tokens)
    for tok in r2:                                        # a fraction reach R2
        total += round2_rate * _full_cost(pricing, tok, out_tokens)
    return PlanningScenario(label=label, round2_rate=_d(round2_rate),
                            output_utilisation=_d(output_utilisation),
                            output_tokens_per_call=out_tokens, projected_cost_usd=_d(total))


def project_fold_cost(
    pricing: PricingArtifact,
    *,
    fold: int,
    r1_input_tokens: list[int],
    r2_input_tokens: list[int],
    reserve_fraction: Decimal = GATE_RESERVE_FRACTION,
    planning_scenarios: bool = True,
) -> FoldCostProjection:
    """Derive the frozen worst-case projection (+ optional planning scenarios) from real inputs.

    ``r1_input_tokens`` / ``r2_input_tokens`` are the REAL ``anthropic_count_tokens`` for each
    task's canonical R1 / worst-case-legal R2 request. Both lists must be per-task and equal length.
    """
    if len(r1_input_tokens) != len(r2_input_tokens):
        raise ValueError("r1/r2 input-token lists must be per-task and equal length")
    if not r1_input_tokens:
        raise ValueError("empty corpus — no requests to project")

    out = GATE_OUTPUT_TOKENS_PER_CALL
    worst = Decimal(0)
    max_single = Decimal(0)
    for tok in r1_input_tokens:                           # 100% R1
        worst += _full_cost(pricing, tok, out)
        max_single = max(max_single, max_call_cost_usd(pricing, input_tokens=tok,
                                                       max_output_tokens=out))
    for tok in r2_input_tokens:                           # 100% R2 (gate worst case)
        worst += _full_cost(pricing, tok, out)
        max_single = max(max_single, max_call_cost_usd(pricing, input_tokens=tok,
                                                       max_output_tokens=out))
    worst_with_reserve = worst * (Decimal(1) + reserve_fraction)

    scenarios: list[PlanningScenario] = []
    if planning_scenarios:
        for label, rate in (("r2_0pct", Decimal("0.00")), ("r2_50pct", Decimal("0.50")),
                            ("r2_100pct", Decimal("1.00"))):
            scenarios.append(_planning(pricing, label=label, round2_rate=rate,
                                       output_utilisation=Decimal("1.00"),
                                       r1=r1_input_tokens, r2=r2_input_tokens))

    return FoldCostProjection(
        fold=fold, n_tasks=len(r1_input_tokens),
        r1_input_tokens=list(r1_input_tokens), r2_input_tokens=list(r2_input_tokens),
        reserve_fraction=_d(reserve_fraction),
        worst_fold_cost_usd=_d(worst),
        worst_fold_cost_with_reserve_usd=_d(worst_with_reserve),
        max_single_call_exposure_usd=_d(max_single),
        planning_scenarios=scenarios)


class ExperimentCostProjection(BaseModel):
    """Whole-experiment worst case for the GLOBAL cap (all folds, train + held-out)."""

    n_tasks: int
    worst_multiplier: int = EXPERIMENT_WORST_MULTIPLIER
    reserve_fraction: str = _d(GATE_RESERVE_FRACTION)
    per_task_worst_sum_usd: str                        # S = Σ (full_cost(R1)+full_cost(R2))
    experiment_worst_usd: str                          # 8·S
    experiment_worst_with_reserve_usd: str

    def fits_global_cap(self, global_cap_usd: str | float) -> bool:
        return Decimal(self.experiment_worst_with_reserve_usd) <= Decimal(str(global_cap_usd))


def project_experiment_worst(
    pricing: PricingArtifact, *, r1_input_tokens: list[int], r2_input_tokens: list[int],
    reserve_fraction: Decimal = GATE_RESERVE_FRACTION,
) -> ExperimentCostProjection:
    """Global-cap worst case from the per-task worst (R1+R2 full output) × the frozen 8× structure.

    ``r1/r2_input_tokens`` are the per-task worst counts for ALL corpus tasks (not one fold), since
    the multiplier already accounts for each task's train (×2) and held-out (×6) appearances.
    """
    if len(r1_input_tokens) != len(r2_input_tokens):
        raise ValueError("r1/r2 input-token lists must be per-task and equal length")
    out = GATE_OUTPUT_TOKENS_PER_CALL
    s = Decimal(0)
    for r1, r2 in zip(r1_input_tokens, r2_input_tokens):
        s += _full_cost(pricing, r1, out) + _full_cost(pricing, r2, out)
    worst = s * Decimal(EXPERIMENT_WORST_MULTIPLIER)
    return ExperimentCostProjection(
        n_tasks=len(r1_input_tokens), reserve_fraction=_d(reserve_fraction),
        per_task_worst_sum_usd=_d(s), experiment_worst_usd=_d(worst),
        experiment_worst_with_reserve_usd=_d(worst * (Decimal(1) + reserve_fraction)))
