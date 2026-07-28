"""Estimate results: per call kind, per stage, and the whole request.

Two things this module keeps strictly apart:

**Completeness is not confidence.** Completeness says how much of the needed input was
actually supplied. Confidence would say how likely the range is to contain the truth —
and nothing here has ever been checked against an actual, so confidence stays
``UNKNOWN``. Conflating them is how "we had all the fields" turns into "the number is
right", which is the §2 mistake in a new costume.

**A total is derived, never stored beside its parts.** Aggregates are computed from the
stage estimates so they cannot drift out of agreement with them.
"""
from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts.estimates import Confidence, ConfidenceRange
from ..contracts.scope import ClarifyingQuestion, StageKind
from ..pricing.entities import display_hash, full_sha256
from .request import CallKind


class Band(BaseModel):
    """A best / expected / worst integer triple. The invariant is enforced, not hoped."""

    model_config = ConfigDict(frozen=True)

    best: int
    expected: int
    worst: int

    @model_validator(mode="after")
    def _ordered(self) -> "Band":
        if not (self.best <= self.expected <= self.worst):
            raise ValueError(
                f"band must satisfy best <= expected <= worst, got "
                f"{self.best}/{self.expected}/{self.worst}")
        if self.best < 0:
            raise ValueError("a token or call band cannot be negative")
        return self

    @classmethod
    def zero(cls) -> "Band":
        return cls(best=0, expected=0, worst=0)

    @classmethod
    def flat(cls, value: int) -> "Band":
        return cls(best=value, expected=value, worst=value)

    def __add__(self, other: "Band") -> "Band":
        return Band(best=self.best + other.best,
                    expected=self.expected + other.expected,
                    worst=self.worst + other.worst)

    def scaled(self, factor: int) -> "Band":
        if factor < 0:
            raise ValueError("cannot scale a band by a negative factor")
        return Band(best=self.best * factor, expected=self.expected * factor,
                    worst=self.worst * factor)

    @property
    def spread(self) -> int:
        return self.worst - self.best


class CallGroupEstimate(BaseModel):
    """Tokens attributable to one kind of call within a stage.

    Retries and verification appear here as their own groups. They are real calls that
    cost real money, and a blanket multiplier would let them disappear into a total
    nobody can decompose.
    """

    model_config = ConfigDict(frozen=True)

    call_kind: CallKind
    calls: Band
    input_tokens: Band
    output_tokens: Band

    @property
    def total_tokens(self) -> Band:
        return self.input_tokens + self.output_tokens


class StageUsageEstimate(BaseModel):
    """One stage, decomposed by call kind."""

    model_config = ConfigDict(frozen=True)

    stage_id: str
    kind: StageKind
    groups: list[CallGroupEstimate]

    #: Which rules produced this. Traceable, per the ruleset requirement.
    token_rule_families: list[str] = Field(default_factory=list)
    output_profile_id: str = ""
    assumptions: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

    human_minutes: int = 0
    blocking: bool = True
    parallelizable: bool = True
    #: True when something needed was missing and this stage was estimated anyway.
    partial: bool = False

    @property
    def input_tokens(self) -> Band:
        return sum((g.input_tokens for g in self.groups), Band.zero())

    @property
    def output_tokens(self) -> Band:
        return sum((g.output_tokens for g in self.groups), Band.zero())

    @property
    def total_tokens(self) -> Band:
        return self.input_tokens + self.output_tokens

    @property
    def calls(self) -> Band:
        return sum((g.calls for g in self.groups), Band.zero())

    def group(self, kind: CallKind) -> Optional[CallGroupEstimate]:
        for g in self.groups:
            if g.call_kind is kind:
                return g
        return None


class Completeness(BaseModel):
    """How much of the needed input arrived. **Not** a confidence.

    Deliberately has no method that returns a probability, and the docstring says why:
    a number describing input coverage is not a number describing whether the range
    will contain the truth.
    """

    model_config = ConfigDict(frozen=True)

    stages_total: int
    stages_fully_specified: int
    #: Content bodies whose family was ``UNKNOWN`` and had to use the pessimistic rule.
    unclassified_content_bodies: int = 0
    missing_inputs: list[str] = Field(default_factory=list)
    open_questions: list[ClarifyingQuestion] = Field(default_factory=list)

    @model_validator(mode="after")
    def _coherent(self) -> "Completeness":
        if self.stages_total < 1:
            raise ValueError("completeness needs at least one stage")
        if not (0 <= self.stages_fully_specified <= self.stages_total):
            raise ValueError("stages_fully_specified must lie within stages_total")
        if self.unclassified_content_bodies < 0:
            raise ValueError("unclassified_content_bodies cannot be negative")
        return self

    @property
    def ratio(self) -> Decimal:
        """Fraction of stages fully specified, 0..1. An input-coverage measure only."""
        return Decimal(self.stages_fully_specified) / Decimal(self.stages_total)

    @property
    def is_complete(self) -> bool:
        return (self.stages_fully_specified == self.stages_total
                and not self.missing_inputs
                and not self.unclassified_content_bodies)


class UsageEstimate(BaseModel):
    """The whole request, estimated. Totals are derived from the stages.

    ``confidence`` is fixed at ``UNKNOWN`` by a validator rather than by convention.
    Until an estimate has been compared with an actual, any other value would be a
    claim this system has not earned.
    """

    model_config = ConfigDict(frozen=True)

    request_id: str
    scope_id: str
    plan_id: str
    plan_version: int
    plan_hash: str
    mode: str

    estimator_id: str
    estimator_version: str
    ruleset_version: str
    request_hash: str                      # full 64-hex SHA-256

    stages: list[StageUsageEstimate]
    completeness: Completeness
    confidence: ConfidenceRange

    assumptions: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    #: True when any stage was estimated without everything it needed.
    partial: bool = False
    #: True when a worst case could not be bounded — unbounded retries, or output with
    #: neither a cap nor a defensible profile.
    unbounded: bool = False

    @model_validator(mode="after")
    def _invariants(self) -> "UsageEstimate":
        if not self.stages:
            raise ValueError("an estimate needs at least one stage")
        if self.confidence.level is not Confidence.UNKNOWN:
            raise ValueError(
                "P1b estimates are not calibrated: confidence must stay UNKNOWN until "
                "estimates have been compared against actuals")
        if len(self.request_hash) != 64:
            raise ValueError("request_hash must be a full 64-hex SHA-256")
        ids = [s.stage_id for s in self.stages]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate stage id in estimate")
        # Derived totals must themselves satisfy the band invariant.
        for band in (self.input_tokens, self.output_tokens, self.total_tokens):
            if not (band.best <= band.expected <= band.worst):
                raise ValueError("aggregated band violates best <= expected <= worst")
        return self

    # --- derived totals: computed, never stored ---
    @property
    def input_tokens(self) -> Band:
        return sum((s.input_tokens for s in self.stages), Band.zero())

    @property
    def output_tokens(self) -> Band:
        return sum((s.output_tokens for s in self.stages), Band.zero())

    @property
    def total_tokens(self) -> Band:
        return self.input_tokens + self.output_tokens

    @property
    def calls(self) -> Band:
        return sum((s.calls for s in self.stages), Band.zero())

    @property
    def human_minutes(self) -> int:
        return sum(s.human_minutes for s in self.stages)

    def tokens_by_call_kind(self) -> dict[str, Band]:
        """Where the tokens go. Retries and verification are visible, not folded in."""
        out: dict[str, Band] = {}
        for stage in self.stages:
            for group in stage.groups:
                key = group.call_kind.value
                out[key] = out.get(key, Band.zero()) + group.total_tokens
        return out

    def stage(self, stage_id: str) -> StageUsageEstimate:
        for s in self.stages:
            if s.stage_id == stage_id:
                return s
        raise KeyError(stage_id)

    def canonical_payload(self) -> dict[str, Any]:
        def band(b: Band) -> dict[str, int]:
            return {"best": b.best, "expected": b.expected, "worst": b.worst}

        return {
            "request_id": self.request_id,
            "scope_id": self.scope_id,
            "plan_id": self.plan_id,
            "plan_version": self.plan_version,
            "plan_hash": self.plan_hash,
            "mode": self.mode,
            "estimator_id": self.estimator_id,
            "estimator_version": self.estimator_version,
            "ruleset_version": self.ruleset_version,
            "request_hash": self.request_hash,
            "stages": [
                {
                    "stage_id": s.stage_id,
                    "kind": s.kind.value,
                    "output_profile_id": s.output_profile_id,
                    "token_rule_families": sorted(s.token_rule_families),
                    "groups": [
                        {
                            "call_kind": g.call_kind.value,
                            "calls": band(g.calls),
                            "input_tokens": band(g.input_tokens),
                            "output_tokens": band(g.output_tokens),
                        }
                        for g in sorted(s.groups, key=lambda g: g.call_kind.value)
                    ],
                    "human_minutes": s.human_minutes,
                    "partial": s.partial,
                    "assumptions": s.assumptions,
                    "warnings": s.warnings,
                }
                for s in sorted(self.stages, key=lambda s: s.stage_id)
            ],
            "totals": {
                "input_tokens": band(self.input_tokens),
                "output_tokens": band(self.output_tokens),
                "total_tokens": band(self.total_tokens),
                "calls": band(self.calls),
                "human_minutes": self.human_minutes,
            },
            "completeness": {
                "stages_total": self.completeness.stages_total,
                "stages_fully_specified": self.completeness.stages_fully_specified,
                "unclassified_content_bodies":
                    self.completeness.unclassified_content_bodies,
                "missing_inputs": sorted(self.completeness.missing_inputs),
            },
            "confidence": self.confidence.level.value,
            "partial": self.partial,
            "unbounded": self.unbounded,
            "assumptions": self.assumptions,
            "warnings": self.warnings,
            "limitations": self.limitations,
        }

    def canonical_json(self) -> str:
        return json.dumps(self.canonical_payload(), sort_keys=True,
                          separators=(",", ":"), ensure_ascii=False)

    def audit_hash(self) -> str:
        """Full 64-hex SHA-256 of the canonical form."""
        return full_sha256(self.canonical_json())

    def display_audit_hash(self) -> str:
        return display_hash(self.audit_hash())
