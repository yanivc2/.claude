"""Governance (P1c.1) — the artifacts and rules that make a spend decision auditable.

What this layer adds over plain admission and approval:

* **Purpose.** ``REAL_SPEND`` or ``SIMULATION``, named rather than implied by a
  boolean. A simulation authorization can never be promoted to real spend.
* **Snapshots.** ``BudgetSnapshot`` and ``PlanSnapshot`` are content-hashed, and the
  plan's identity is computed **from the plan** rather than taken on trust.
* **Full binding.** An approval names every artifact it was granted against; changing
  any one of them means it no longer covers the run, and ``diff`` says which.
* **Blocking vs acknowledgeable.** A blocking condition cannot be signed away. An
  acknowledgeable risk must be signed for, by name.
* **Stale-state refusal.** The budget snapshot at authorization must equal the one
  approved.
* **ExecutionAuthorization.** A scoped grant — model, mode, ceilings, amount, window —
  not a decision id.
* **Override.** Raises a cap and invalidates the whole chain below it.
* **Reservations.** Idempotent, with a lifecycle that refuses illegal moves and flags
  overruns rather than absorbing them.

Two limits stated plainly, because over-reading either would be dangerous:

* **Logical protection, not transactional.** Snapshots detect that state moved. They
  do not serialise concurrent writers; that needs persistence, which does not exist yet.
* **A content hash is not a signature.** It shows an artifact is unmodified since
  hashing. It attests nothing about who produced it.
"""
from __future__ import annotations

from .admission import GovernedAdmission, GovernedBudgetGuard
from .authorization import (
    HASH_IS_NOT_A_SIGNATURE,
    ExecutionAuthorization,
    UsageCeiling,
)
from .binding import BOUND_FIELDS, ApprovalBinding
from .canonical import CanonicalMixin, canonical_json, content_hash
from .conditions import (
    Acknowledgement,
    Condition,
    ConditionCode,
    ConditionSet,
    ConditionSeverity,
    severity_of,
)
from .errors import (
    BindingMismatchError,
    BlockedByConditionError,
    GovernanceError,
    IdempotencyConflictError,
    InvalidReservationTransitionError,
    MissingAcknowledgementError,
    OverrunError,
    PriceTooOldError,
    PurposeMismatchError,
    ReserveModeNotPermittedError,
    StaleSnapshotError,
)
from .events import GovernanceEvent, GovernanceEventLog, GovernanceEventType
from .freshness import PriceFreshnessPolicy, assert_fresh, check_freshness, price_age_days
from .gate import (
    GovernedApproval,
    GovernedApprovalGate,
    GovernedApprovalRequest,
    build_binding,
)
from .override import BudgetOverride, OverrideOutcome
from .purpose import (
    NOT_ELIGIBLE_MARKER,
    SpendPurpose,
    assert_not_promotable,
    eligibility_markers,
    trust_permitted,
)
from .reservation import (
    OPEN_STATUSES,
    SettlementResult,
    SpendReservation,
    SpendReservationBook,
    SpendReservationStatus,
)
from .snapshots import BudgetSnapshot, PlanSnapshot, PlanStageSnapshot

__all__ = [
    # purpose
    "SpendPurpose", "NOT_ELIGIBLE_MARKER", "trust_permitted", "eligibility_markers",
    "assert_not_promotable",
    # canonical
    "CanonicalMixin", "canonical_json", "content_hash",
    # snapshots
    "BudgetSnapshot", "PlanSnapshot", "PlanStageSnapshot",
    # conditions
    "Condition", "ConditionCode", "ConditionSeverity", "ConditionSet",
    "Acknowledgement", "severity_of",
    # freshness
    "PriceFreshnessPolicy", "check_freshness", "assert_fresh", "price_age_days",
    # admission
    "GovernedBudgetGuard", "GovernedAdmission",
    # binding + approval
    "ApprovalBinding", "BOUND_FIELDS", "build_binding",
    "GovernedApprovalGate", "GovernedApprovalRequest", "GovernedApproval",
    # authorization
    "ExecutionAuthorization", "UsageCeiling", "HASH_IS_NOT_A_SIGNATURE",
    # override
    "BudgetOverride", "OverrideOutcome",
    # reservations
    "SpendReservation", "SpendReservationBook", "SpendReservationStatus",
    "SettlementResult", "OPEN_STATUSES",
    # events
    "GovernanceEvent", "GovernanceEventLog", "GovernanceEventType",
    # errors
    "GovernanceError", "BlockedByConditionError", "MissingAcknowledgementError",
    "StaleSnapshotError", "BindingMismatchError", "PurposeMismatchError",
    "ReserveModeNotPermittedError", "PriceTooOldError", "IdempotencyConflictError",
    "InvalidReservationTransitionError", "OverrunError",
]
