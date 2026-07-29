"""Ports — the seams where the four undecided questions will eventually be answered.

Four decisions are explicitly *not* being made in P0:

1. where the package finally lives,
2. the source of truth for model/provider pricing,
3. how confidence ranges are computed,
4. the calibration/learning mechanism, once actuals exist.

Each gets a ``Protocol`` here and no implementation anywhere. A Protocol commits to
the shape of the question without answering it, so the decision stays reversible: the
architecture note argues a preference for each, and none of them is wired in.

There is deliberately no default implementation, not even a trivial one. A default is
a decision that nobody remembers making.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable

from .actuals import ActualUsage, EstimateVariance
from .approval import ApprovalDecision, ApprovalRequest
from .budget import AdmitResult, BudgetPolicy, BudgetState
from .estimates import ConfidenceRange, TokenEstimate
from .money import Money
from .plan import ExecutionMode, ExecutionPlan
from .scope import ClarifyingQuestion, ProjectScope, WorkBreakdown


@runtime_checkable
class PricingSource(Protocol):
    """Open decision 2. Where a price comes from, and how it is pinned.

    ``pricing_ref`` must identify the exact prices used, so an estimate can be checked
    for drift later. Whether that ref is a content hash, a database row or a file
    digest is not settled here.
    """

    def pricing_ref(self) -> str:
        """Opaque identifier of the price set currently in force."""
        ...

    def cost_of(self, usage: TokenEstimate, *, model_id: str) -> Money:
        """Price a token estimate against one registry model."""
        ...

    def max_exposure(self, usage: TokenEstimate, *, model_id: str) -> Money:
        """Worst-case cost of one call: the full output allowance billed as output."""
        ...


@runtime_checkable
class WorkDecomposer(Protocol):
    """Turn a characterised scope into a stage graph, or say what is still missing."""

    def missing_info(self, scope: ProjectScope) -> list[ClarifyingQuestion]:
        ...

    def decompose(self, scope: ProjectScope) -> WorkBreakdown:
        ...


@runtime_checkable
class ConfidenceModel(Protocol):
    """Open decision 3. How a confidence range is arrived at.

    Kept behind a port because the honest answer today is "we do not know": no
    estimator here has been checked against a single actual, and §2 is a live reminder
    of what a confidently-reported uncalibrated number is worth.
    """

    def assess(self, *, scope: ProjectScope, breakdown: WorkBreakdown,
               n_similar_observations: int) -> ConfidenceRange:
        ...


@runtime_checkable
class CostEstimator(Protocol):
    """Produce one costed plan per execution mode. No implementation in P0."""

    def estimate(self, scope: ProjectScope, breakdown: WorkBreakdown,
                 mode: ExecutionMode) -> ExecutionPlan:
        ...

    def estimate_all_modes(self, scope: ProjectScope,
                           breakdown: WorkBreakdown) -> list[ExecutionPlan]:
        """Must cover at least ``REQUIRED_EXECUTION_MODES``."""
        ...


@runtime_checkable
class BudgetGuard(Protocol):
    """Admission control. Both methods answer *before* money is committed."""

    def admit(self, plan: ExecutionPlan, policy: BudgetPolicy,
              state: BudgetState) -> AdmitResult:
        ...

    def checkpoint(self, policy: BudgetPolicy, state: BudgetState,
                   additional: Money) -> AdmitResult:
        ...


@runtime_checkable
class ApprovalGate(Protocol):
    """Present a plan for decision and record the answer. Records are append-only."""

    def present(self, plan: ExecutionPlan,
                alternatives: list[ExecutionPlan]) -> ApprovalRequest:
        ...

    def record(self, request: ApprovalRequest,
               decision: ApprovalDecision) -> ApprovalDecision:
        ...

    def effective_decision(self, plan_id: str) -> ApprovalDecision | None:
        """The decision currently in force for a plan, if any."""
        ...


@runtime_checkable
class UsageCollector(Protocol):
    """Persist reconciled actuals. Must reject records failing the observability check."""

    def record(self, usage: ActualUsage) -> None:
        ...

    def for_plan(self, plan_id: str) -> list[ActualUsage]:
        ...


@runtime_checkable
class VarianceReporter(Protocol):
    """Compare estimate to actual. Reporting only — it never updates an estimator."""

    def compute(self, plan: ExecutionPlan,
                actuals: list[ActualUsage]) -> EstimateVariance:
        ...


@runtime_checkable
class Calibrator(Protocol):
    """Open decision 4. Deliberately unimplemented, and gated on evidence.

    ``propose_adjustment`` returns a *proposal*, never an applied change, and
    ``may_calibrate`` exists so the gate on sample size is part of the contract rather
    than the discretion of whoever writes the estimator. The §2 result — an effect
    indistinguishable from noise at n=8 — is why the guard is in the type.
    """

    def may_calibrate(self, task_family: str) -> bool:
        """False until enough usable observations exist for this family alone."""
        ...

    def propose_adjustment(self, task_family: str,
                           observations: list[EstimateVariance]) -> dict | None:
        """A reviewable proposal, versioned and reversible. Never self-applied."""
        ...
