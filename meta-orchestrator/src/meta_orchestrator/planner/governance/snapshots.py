"""Canonical snapshots of the two things a decision depends on: the budget and the plan.

Both exist so that "what did we approve" has an exact answer. Both are content-hashed,
so a change anywhere in them changes their identity and any approval bound to the old
hash simply stops applying.

**A caveat stated up front, because it is easy to over-read:** this is *logical*
protection. It detects that state has moved between admission and authorization. It is
**not** a transaction and **not** a lock — two processes racing on the same budget with
no shared store can each hold a snapshot that was accurate when taken. Nothing here
prevents that, and nothing should be described as if it does. Transactional protection
needs persistence, which is a later phase.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts.budget import BudgetPolicy, BudgetState
from ..contracts.money import Money
from ..contracts.plan import ExecutionMode, ExecutionPlan
from .canonical import CanonicalMixin


class BudgetSnapshot(BaseModel, CanonicalMixin):
    """The budget position at one instant, as one addressable artifact.

    ``BudgetGuard`` takes this rather than a handful of loose numbers, so an admission
    can name the exact position it was made against.

    ``provider_credits`` is informational and is deliberately **excluded from the
    hash**: it is operator-reported runtime state that may drift for reasons that have
    nothing to do with this plan, and letting it invalidate approvals would train
    everyone to re-approve reflexively.
    """

    model_config = ConfigDict(frozen=True)

    budget_id: str
    policy_id: str
    policy_hash: str
    currency: str
    hard_cap: Money
    #: The cap actually in force — raised by any approved override.
    effective_cap: Money
    actual_spend: Money
    committed_spend: Money
    approved_override_ids: list[str] = Field(default_factory=list)
    snapshot_version: int = 1
    taken_at: str = ""
    #: Informational only. Not a cap, and not part of the identity.
    provider_credits: Optional[Money] = None

    @model_validator(mode="after")
    def _coherent(self) -> "BudgetSnapshot":
        for name in ("hard_cap", "effective_cap", "actual_spend", "committed_spend"):
            money: Money = getattr(self, name)
            if money.currency != self.currency:
                raise ValueError(f"{name} must be in the snapshot's currency")
            if money.is_negative():
                raise ValueError(f"{name} cannot be negative")
        if self.effective_cap < self.hard_cap:
            raise ValueError(
                "effective_cap is below hard_cap — an override may only raise the "
                "ceiling, never lower it silently")
        if self.effective_cap > self.hard_cap and not self.approved_override_ids:
            raise ValueError(
                "effective_cap exceeds hard_cap with no approved override to justify it")
        if self.snapshot_version < 1:
            raise ValueError("snapshot_version starts at 1")
        return self

    @classmethod
    def of(cls, policy: BudgetPolicy, state: BudgetState, *, budget_id: str,
           taken_at: str, effective_cap: Optional[Money] = None,
           override_ids: Optional[list[str]] = None,
           snapshot_version: int = 1) -> "BudgetSnapshot":
        return cls(
            budget_id=budget_id, policy_id=policy.policy_id,
            policy_hash=policy.policy_hash or "unhashed",
            currency=policy.currency, hard_cap=policy.cap.limit,
            effective_cap=effective_cap or policy.cap.limit,
            actual_spend=state.actual, committed_spend=state.committed,
            approved_override_ids=list(override_ids or []),
            snapshot_version=snapshot_version, taken_at=taken_at,
            provider_credits=policy.reported_provider_credits)

    @property
    def encumbered(self) -> Money:
        return self.actual_spend + self.committed_spend

    @property
    def remaining(self) -> Money:
        return self.effective_cap - self.encumbered

    def would_exceed(self, additional: Money) -> bool:
        return (self.encumbered + additional) > self.effective_cap

    def canonical_payload(self) -> dict:
        # provider_credits is excluded on purpose — see the class docstring.
        return {
            "budget_id": self.budget_id,
            "policy_id": self.policy_id,
            "policy_hash": self.policy_hash,
            "currency": self.currency,
            "hard_cap": self.hard_cap,
            "effective_cap": self.effective_cap,
            "actual_spend": self.actual_spend,
            "committed_spend": self.committed_spend,
            "approved_override_ids": sorted(self.approved_override_ids),
            "snapshot_version": self.snapshot_version,
        }


class PlanStageSnapshot(BaseModel, CanonicalMixin):
    """The parts of a stage that change what a run costs or does."""

    model_config = ConfigDict(frozen=True)

    stage_id: str
    kind: str
    depends_on: list[str] = Field(default_factory=list)
    blocking: bool = True
    parallelizable: bool = True
    human_minutes: int = 0

    def canonical_payload(self) -> dict:
        return {"stage_id": self.stage_id, "kind": self.kind,
                "depends_on": sorted(self.depends_on), "blocking": self.blocking,
                "parallelizable": self.parallelizable,
                "human_minutes": self.human_minutes}


class PlanSnapshot(BaseModel, CanonicalMixin):
    """A plan's identity, **computed from the plan** rather than taken on trust.

    ``ExecutionPlan.plan_hash`` is a field a caller fills in, and a field a caller
    fills in is a field a caller can get wrong or stale. ``PlanSnapshot.of()`` derives
    the hash from the plan's own contents, so editing any material field changes it
    whether or not anybody remembered to update ``plan_hash``.
    """

    model_config = ConfigDict(frozen=True)

    plan_id: str
    plan_version: int
    mode: ExecutionMode
    stages: list[PlanStageSnapshot]
    model_ids: list[str] = Field(default_factory=list)
    deliverables: list[str] = Field(default_factory=list)
    stop_conditions: list[str] = Field(default_factory=list)
    exclusions: list[str] = Field(default_factory=list)
    tradeoffs: list[str] = Field(default_factory=list)
    human_tasks: list[str] = Field(default_factory=list)
    estimator_ref: str = ""
    #: The hash the plan carried, kept for comparison — never used as the identity.
    declared_plan_hash: str = ""
    scope_id: str = ""

    @classmethod
    def of(cls, plan: ExecutionPlan) -> "PlanSnapshot":
        return cls(
            plan_id=plan.plan_id,
            plan_version=plan.plan_version,
            mode=plan.mode,
            stages=[PlanStageSnapshot(
                stage_id=s.item_id, kind=s.kind.value, depends_on=list(s.depends_on),
                blocking=s.blocking, parallelizable=s.parallelizable,
                human_minutes=s.human_minutes) for s in plan.stages],
            model_ids=list(plan.model_ids),
            deliverables=list(plan.deliverables),
            stop_conditions=[f"{c.kind.value}:{c.description}"
                             for c in plan.stop_conditions],
            exclusions=list(plan.exclusions),
            tradeoffs=list(plan.tradeoffs),
            human_tasks=list(plan.human_tasks),
            estimator_ref=(f"{plan.estimator.estimator_id}@"
                           f"{plan.estimator.estimator_version}"),
            declared_plan_hash=plan.plan_hash,
            scope_id=plan.scope_id,
        )

    @property
    def declared_hash_matches(self) -> bool:
        """Whether the plan's own ``plan_hash`` agrees with the computed identity.

        A mismatch is not automatically wrong — the declared hash may use a different
        scheme — but it means the declared value cannot be relied on for binding.
        """
        return self.declared_plan_hash == self.content_hash()

    def canonical_payload(self) -> dict:
        return {
            "plan_id": self.plan_id,
            "plan_version": self.plan_version,
            "scope_id": self.scope_id,
            "mode": self.mode.value,
            "stages": [s.canonical_payload()
                       for s in sorted(self.stages, key=lambda s: s.stage_id)],
            "model_ids": sorted(self.model_ids),
            "deliverables": list(self.deliverables),
            "stop_conditions": sorted(self.stop_conditions),
            "exclusions": list(self.exclusions),
            "tradeoffs": list(self.tradeoffs),
            "human_tasks": list(self.human_tasks),
            "estimator_ref": self.estimator_ref,
        }
