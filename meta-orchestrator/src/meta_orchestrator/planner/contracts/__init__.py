"""Pre-execution Project Cost Planner — P0 contracts.

Types, state transitions and ports only. Nothing here estimates, prices, approves,
spends or executes; nothing imports from ``experiment/s2`` and nothing under that
frozen tree imports from here.

The module boundary, in one line each:

* :mod:`.money`      — ``Decimal`` money and best/expected/worst ranges
* :mod:`.scope`      — the request, what is still unknown, the stage graph
* :mod:`.estimates`  — tokens, cost, time, confidence, estimator identity
* :mod:`.plan`       — execution modes, plan lifecycle, transition table
* :mod:`.budget`     — caps, live position, admission, audited overrides
* :mod:`.approval`   — the record that makes execution legitimate
* :mod:`.actuals`    — what happened, with mandatory raw evidence, and the variance
* :mod:`.events`     — append-only evidence of decisions
* :mod:`.errors`     — fail-closed error contracts
* :mod:`.ports`      — Protocols for the four decisions P0 does not make

See ``docs/planner/ARCHITECTURE_P0.md`` for the boundaries and the open decisions.
"""
from __future__ import annotations

from .actuals import (
    ActualUsage,
    EstimateVariance,
    OutcomeStatus,
    RawEvidence,
    VarianceSource,
    assert_observability_complete,
)
from .approval import (
    ApprovalDecision,
    ApprovalRequest,
    ApprovalStatus,
    ApproverKind,
    assert_may_execute,
)
from .budget import (
    AdmitDecision,
    AdmitResult,
    BreachAction,
    BudgetOverride,
    BudgetPolicy,
    BudgetState,
    HardBudgetCap,
)
from .errors import (
    ApprovalRequiredError,
    BudgetExceededError,
    IllegalTransitionError,
    ObservabilityIncompleteError,
    PlannerError,
    PricingDriftError,
    ScopeIncompleteError,
)
from .estimates import (
    Confidence,
    ConfidenceRange,
    CostEstimate,
    EstimatorVersion,
    TimeEstimate,
    TimeEstimateRange,
    TokenEstimate,
    TokenEstimateRange,
)
from .events import (
    ApprovalGrantedEvent,
    BudgetThresholdCrossedEvent,
    EventType,
    ExecutionStartedEvent,
    PlanEstimatedEvent,
    PlannerEvent,
    UsageRecordedEvent,
    VarianceComputedEvent,
    approval_covers_execution,
)
from .money import DEFAULT_CURRENCY, MONEY_SCALE, Money, MoneyRange
from .plan import (
    ALLOWED_TRANSITIONS,
    REQUIRED_EXECUTION_MODES,
    TERMINAL_STATUSES,
    ExecutionMode,
    ExecutionPlan,
    PlanStatus,
    StageEstimate,
    StopCondition,
    StopConditionKind,
    assert_transition,
    can_transition,
    requires_approval_record,
)
from .ports import (
    ApprovalGate,
    BudgetGuard,
    Calibrator,
    ConfidenceModel,
    CostEstimator,
    PricingSource,
    UsageCollector,
    VarianceReporter,
    WorkDecomposer,
)
from .scope import (
    ClarifyingQuestion,
    EstimateAssumptions,
    ProjectScope,
    QualityTarget,
    RiskTolerance,
    StageKind,
    WorkBreakdown,
    WorkItem,
)

__all__ = [
    # money
    "Money", "MoneyRange", "DEFAULT_CURRENCY", "MONEY_SCALE",
    # scope
    "ProjectScope", "ClarifyingQuestion", "EstimateAssumptions", "WorkBreakdown",
    "WorkItem", "StageKind", "QualityTarget", "RiskTolerance",
    # estimates
    "TokenEstimate", "TokenEstimateRange", "CostEstimate", "TimeEstimate",
    "TimeEstimateRange", "ConfidenceRange", "Confidence", "EstimatorVersion",
    # plan
    "ExecutionPlan", "ExecutionMode", "StageEstimate", "PlanStatus", "StopCondition",
    "StopConditionKind", "ALLOWED_TRANSITIONS", "TERMINAL_STATUSES",
    "REQUIRED_EXECUTION_MODES", "can_transition", "assert_transition",
    "requires_approval_record",
    # budget
    "BudgetPolicy", "HardBudgetCap", "BudgetState", "BudgetOverride", "BreachAction",
    "AdmitDecision", "AdmitResult",
    # approval
    "ApprovalRequest", "ApprovalDecision", "ApprovalStatus", "ApproverKind",
    "assert_may_execute",
    # actuals
    "ActualUsage", "RawEvidence", "EstimateVariance", "OutcomeStatus", "VarianceSource",
    "assert_observability_complete",
    # events
    "PlannerEvent", "EventType", "PlanEstimatedEvent", "ApprovalGrantedEvent",
    "ExecutionStartedEvent", "BudgetThresholdCrossedEvent", "UsageRecordedEvent",
    "VarianceComputedEvent", "approval_covers_execution",
    # errors
    "PlannerError", "IllegalTransitionError", "ApprovalRequiredError",
    "BudgetExceededError", "ScopeIncompleteError", "ObservabilityIncompleteError",
    "PricingDriftError",
    # ports
    "PricingSource", "WorkDecomposer", "ConfidenceModel", "CostEstimator",
    "BudgetGuard", "ApprovalGate", "UsageCollector", "VarianceReporter", "Calibrator",
]
