"""What a shadow run produces, and where it is put.

Two artifacts, both content-addressed:

* :class:`PlannerShadowResult` — the observation. The Planner's estimate and cost
  projection, the legacy runtime estimate it is being compared against, and the exact
  divergence between them. It changes nothing; it is a record that the Planner *would*
  have said this.
* :class:`ShadowFailure` — the shadow could not produce a full observation. Recorded,
  never swallowed, and classified by :class:`ShadowFailureKind`.

Both go to a :class:`ShadowSink`. The default sink keeps them in memory: P2a does not
open a database on the runtime path, so nothing here persists unless an operator wires
a persisting sink in deliberately. The runtime the Planner observes is never touched
either way.

**A content hash is not a signature.** It proves the artifact has not changed since it
was produced; it says nothing about who produced it.

**Timing is measured, not hashed.** ``latency`` is a wall-clock measurement that varies
run to run. It is carried alongside the result but excluded from the canonical payload,
so the identity of a shadow result depends only on *what the Planner concluded*, not on
how long it took — two runs of the same request produce the same hash.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

from ..contracts.money import Money
from ..governance.canonical import CanonicalMixin, content_hash
from ..pricing.entities import PriceTrust


def _money_payload(m: Optional[Money]) -> Optional[dict[str, str]]:
    return None if m is None else {"amount": str(m.amount), "currency": m.currency}


class ShadowLatency(BaseModel):
    """Local wall-clock cost of running the shadow, in milliseconds.

    Planner-side only: adapter construction, estimation, pricing, governance preview,
    and (if ever enabled) persistence. No provider latency is measured and no network
    call is made — there is nothing remote on this path to time.

    Excluded from the result's canonical payload on purpose: a measurement that varies
    between runs must not change the identity of the conclusion.
    """

    model_config = ConfigDict(frozen=True)

    adapter_construction_ms: float = 0.0
    estimation_ms: float = 0.0
    pricing_ms: float = 0.0
    governance_preview_ms: float = 0.0
    persistence_ms: float = 0.0
    total_ms: float = 0.0


class CandidateCostLine(BaseModel):
    """One candidate model's projected cost, carried verbatim from the projection."""

    model_config = ConfigDict(frozen=True)

    model_id: str
    available: bool
    unavailable_reason: Optional[str] = None
    best: Optional[Money] = None
    expected: Optional[Money] = None
    worst: Optional[Money] = None
    price_trust: Optional[PriceTrust] = None
    authoritative_for_real_spend: bool = False
    price_verified_at: Optional[str] = None
    price_card_id: Optional[str] = None
    warnings: list[str] = Field(default_factory=list)

    def canonical_payload(self) -> dict[str, Any]:
        return {
            "model_id": self.model_id,
            "available": self.available,
            "unavailable_reason": self.unavailable_reason,
            "best": _money_payload(self.best),
            "expected": _money_payload(self.expected),
            "worst": _money_payload(self.worst),
            "price_trust": self.price_trust.value if self.price_trust else None,
            "authoritative_for_real_spend": self.authoritative_for_real_spend,
            "price_verified_at": self.price_verified_at,
            "price_card_id": self.price_card_id,
            "warnings": list(self.warnings),
        }


class DivergenceReport(BaseModel, CanonicalMixin):
    """Legacy runtime estimate vs Planner estimate, and the gap between them.

    The comparison is the whole point of shadow mode: it says, without acting on it,
    whether the product estimator agrees with the ``chars // 4`` heuristic the runtime
    actually uses. ``legacy_*_in_planner_range`` answers the one question that matters
    first — is the number the runtime is using even inside the range the Planner
    considers plausible?
    """

    model_config = ConfigDict(frozen=True)

    # --- tokens (model-independent) ---
    legacy_tokens: int
    planner_tokens_best: int
    planner_tokens_expected: int
    planner_tokens_worst: int
    legacy_tokens_in_planner_range: bool
    #: expected − legacy. Positive means the Planner expects more than the heuristic.
    token_divergence_abs: int
    #: |divergence| / legacy, as a fraction. None when legacy is zero (no denominator).
    token_divergence_pct: Optional[Decimal] = None

    # --- cost (anchored to the worst-case candidate; None when no price is available) ---
    legacy_cost: Optional[Money] = None
    planner_cost_best: Optional[Money] = None
    planner_cost_expected: Optional[Money] = None
    planner_cost_worst: Optional[Money] = None
    legacy_cost_in_planner_range: Optional[bool] = None
    cost_divergence_abs: Optional[Money] = None
    cost_divergence_pct: Optional[Decimal] = None

    def canonical_payload(self) -> dict[str, Any]:
        return {
            "legacy_tokens": self.legacy_tokens,
            "planner_tokens_best": self.planner_tokens_best,
            "planner_tokens_expected": self.planner_tokens_expected,
            "planner_tokens_worst": self.planner_tokens_worst,
            "legacy_tokens_in_planner_range": self.legacy_tokens_in_planner_range,
            "token_divergence_abs": self.token_divergence_abs,
            "token_divergence_pct": (None if self.token_divergence_pct is None
                                     else str(self.token_divergence_pct)),
            "legacy_cost": _money_payload(self.legacy_cost),
            "planner_cost_best": _money_payload(self.planner_cost_best),
            "planner_cost_expected": _money_payload(self.planner_cost_expected),
            "planner_cost_worst": _money_payload(self.planner_cost_worst),
            "legacy_cost_in_planner_range": self.legacy_cost_in_planner_range,
            "cost_divergence_abs": _money_payload(self.cost_divergence_abs),
            "cost_divergence_pct": (None if self.cost_divergence_pct is None
                                    else str(self.cost_divergence_pct)),
        }


class PlannerShadowResult(BaseModel, CanonicalMixin):
    """One shadow observation. Changes nothing; records what the Planner concluded.

    ``purpose`` is always SIMULATION and ``eligibility_marker`` is always
    NOT_ELIGIBLE_FOR_REAL_SPEND: nothing a shadow run produces may ever back real
    spend, and the artifact says so on its face.

    The pre-flight gate has not selected a model yet — selection happens after the
    circuit breaker — so ``selected_model`` is ``None`` by construction and the cost is
    anchored to ``worst_case_model_id`` (the dearest candidate), the same fail-safe
    basis the legacy circuit breaker uses.
    """

    model_config = ConfigDict(frozen=True)

    schema_version: str = "planner-shadow-result-v1"
    request_id: str
    correlation_id: str
    generated_at: str

    # governance framing — invariant for every shadow artifact
    purpose: str = "simulation"
    eligibility_marker: str = "NOT_ELIGIBLE_FOR_REAL_SPEND"

    # models
    candidate_model_ids: list[str]
    selected_model: Optional[str] = None          # None: no model is selected pre-flight
    worst_case_model_id: Optional[str] = None      # dearest candidate the cost is anchored to

    # estimate framing
    assumptions: list[str] = Field(default_factory=list)
    confidence: str = "unknown"                    # P1b estimates are never calibrated
    completeness_ratio: str = "0"
    estimate_partial: bool = False

    divergence: DivergenceReport
    per_candidate_costs: list[CandidateCostLine] = Field(default_factory=list)

    # pricing authority (§12) — stated plainly, never overstated
    price_trust: Optional[PriceTrust] = None
    authoritative_for_real_spend: bool = False
    price_age_days: Optional[int] = None
    freshness_warning: Optional[str] = None

    # governance preview
    governance_preview_available: bool = False
    would_admit_as_simulation: Optional[bool] = None
    blocking_condition_codes: list[str] = Field(default_factory=list)
    acknowledgeable_condition_codes: list[str] = Field(default_factory=list)

    warnings: list[str] = Field(default_factory=list)

    # provenance
    estimator_id: str = ""
    estimator_version: str = ""
    ruleset_version: str = ""
    pricing_ref: str = ""
    flags_fingerprint: str = ""

    #: Measured, not hashed — see the module docstring.
    latency: ShadowLatency = ShadowLatency()

    def canonical_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "request_id": self.request_id,
            "correlation_id": self.correlation_id,
            "generated_at": self.generated_at,
            "purpose": self.purpose,
            "eligibility_marker": self.eligibility_marker,
            "candidate_model_ids": list(self.candidate_model_ids),
            "selected_model": self.selected_model,
            "worst_case_model_id": self.worst_case_model_id,
            "assumptions": list(self.assumptions),
            "confidence": self.confidence,
            "completeness_ratio": self.completeness_ratio,
            "estimate_partial": self.estimate_partial,
            "divergence": self.divergence.canonical_payload(),
            "per_candidate_costs": [c.canonical_payload() for c in self.per_candidate_costs],
            "price_trust": self.price_trust.value if self.price_trust else None,
            "authoritative_for_real_spend": self.authoritative_for_real_spend,
            "price_age_days": self.price_age_days,
            "freshness_warning": self.freshness_warning,
            "governance_preview_available": self.governance_preview_available,
            "would_admit_as_simulation": self.would_admit_as_simulation,
            "blocking_condition_codes": list(self.blocking_condition_codes),
            "acknowledgeable_condition_codes": list(self.acknowledgeable_condition_codes),
            "warnings": list(self.warnings),
            "estimator_id": self.estimator_id,
            "estimator_version": self.estimator_version,
            "ruleset_version": self.ruleset_version,
            "pricing_ref": self.pricing_ref,
            "flags_fingerprint": self.flags_fingerprint,
        }

    def content_hash(self) -> str:
        return content_hash(self.canonical_payload())


class ShadowFailure(BaseModel, CanonicalMixin):
    """A shadow run that did not produce a full result. Recorded, never hidden.

    Carries a classified ``kind`` and the phase that raised, so a shadow that stopped
    working points at which Planner component is not ready — rather than disappearing.
    The message is a short summary; no stack object and no user content is retained.
    """

    model_config = ConfigDict(frozen=True)

    schema_version: str = "planner-shadow-failure-v1"
    request_id: str
    correlation_id: str
    generated_at: str
    kind: str
    phase: str
    message: str
    flags_fingerprint: str = ""
    latency: ShadowLatency = ShadowLatency()

    def canonical_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "request_id": self.request_id,
            "correlation_id": self.correlation_id,
            "generated_at": self.generated_at,
            "kind": self.kind,
            "phase": self.phase,
            "message": self.message,
            "flags_fingerprint": self.flags_fingerprint,
        }

    def content_hash(self) -> str:
        return content_hash(self.canonical_payload())


@runtime_checkable
class ShadowSink(Protocol):
    """Where shadow artifacts go. The runtime never reads them back."""

    def record_result(self, result: PlannerShadowResult) -> None: ...

    def record_failure(self, failure: ShadowFailure) -> None: ...


class InMemoryShadowSink:
    """The P2a default sink. Keeps artifacts in memory; opens no database.

    Disposable by construction: dropping the sink drops the observations, which is
    exactly the rollback story P2a asks for — nothing on disk to migrate or clean up.
    """

    def __init__(self) -> None:
        self.results: list[PlannerShadowResult] = []
        self.failures: list[ShadowFailure] = []

    def record_result(self, result: PlannerShadowResult) -> None:
        self.results.append(result)

    def record_failure(self, failure: ShadowFailure) -> None:
        self.failures.append(failure)

    @property
    def last_result(self) -> Optional[PlannerShadowResult]:
        return self.results[-1] if self.results else None

    @property
    def last_failure(self) -> Optional[ShadowFailure]:
        return self.failures[-1] if self.failures else None
