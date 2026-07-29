"""The shadow runner — the Planner as an observer, wired to nothing it can move.

One entry point, :meth:`ShadowRunner.run_shadow`. It takes what the orchestrator is
about to run, produces the Planner's estimate, cost projection and governance preview,
compares them against the legacy runtime estimate, and records the result off to the
side. It returns that result too, but the orchestrator ignores the return value: the
observation lives in the sink, not in the run.

Three guarantees hold it to "observer":

* **It never raises to its caller.** Every failure is caught, classified, and recorded
  as a :class:`ShadowFailure`; the method returns ``None`` and the runtime continues.
* **It spends nothing and reserves nothing.** Purpose is SIMULATION throughout. No
  reservation is created, no committed or actual spend moves, no database is opened.
* **It refuses to be promoted.** If enforcement or real spend is switched on, the
  runner raises :class:`ShadowConfigError` at construction — loudly, because that is a
  misconfiguration, not a runtime condition to observe.

No network, no provider call, no ``count_tokens``. Everything is computed from content
the orchestrator already holds. The only clock read is the injected ``now`` for the
result's timestamp; ``timer`` is a monotonic stopwatch for latency, never an identity.
"""
from __future__ import annotations

import time
from decimal import Decimal
from typing import Callable, Optional

from ..contracts.money import Money
from ..estimation.entities import UsageEstimate
from ..estimation.errors import (
    EstimationError,
    InconsistentEstimateError,
    UnboundedEstimateError,
)
from ..estimation.estimator import UsageEstimator
from ..estimation.profiles import ESTIMATOR_ID, ESTIMATOR_VERSION, RULESET_VERSION
from ..estimation.projection import CostProjection, EstimateProjector
from ..governance.admission import GovernedBudgetGuard
from ..governance.canonical import content_hash
from ..governance.freshness import price_age_days
from ..governance.purpose import SpendPurpose
from ..governance.snapshots import BudgetSnapshot
from ..pricing.entities import PriceTrust
from .case import ShadowCase
from .errors import ShadowConfigError, ShadowFailureKind
from .request_adapter import build_request
from .result import (
    CandidateCostLine,
    DivergenceReport,
    InMemoryShadowSink,
    PlannerShadowResult,
    ShadowFailure,
    ShadowLatency,
    ShadowSink,
)


def _fraction(part: Decimal, whole: Decimal) -> Optional[Decimal]:
    """|part| / whole, or None when there is no denominator."""
    if whole == 0:
        return None
    return (abs(part) / whole).quantize(Decimal("0.0001"))


class ShadowRunner:
    """Runs the Planner in shadow for one task at a time. Holds no run state.

    ``enforcement`` and ``real_spend`` must both be ``False``: they are accepted only so
    the runner can *refuse* them, making an accidental promotion a construction error
    rather than a silent behaviour change.
    """

    def __init__(self, *, now: Callable[[], str], sink: Optional[ShadowSink] = None,
                 enforcement: bool = False, real_spend: bool = False,
                 timer: Callable[[], float] = time.perf_counter) -> None:
        if enforcement:
            raise ShadowConfigError(
                "planner_enforcement_enabled is not permitted in shadow mode (P2a): the "
                "Planner may observe, never enforce")
        if real_spend:
            raise ShadowConfigError(
                "planner_real_spend_enabled is not permitted in shadow mode (P2a): a "
                "shadow run may not back real spend")
        self._now = now
        self._timer = timer
        self.sink: ShadowSink = sink or InMemoryShadowSink()
        self._estimator = UsageEstimator()
        self._projector = EstimateProjector()
        self._guard = GovernedBudgetGuard()
        self._flags_fingerprint = content_hash({
            "planner_enabled": True,
            "planner_shadow_mode": True,
            "planner_enforcement_enabled": False,
            "planner_real_spend_enabled": False,
        })

    # ------------------------------------------------------------------ #
    # public entry point                                                  #
    # ------------------------------------------------------------------ #
    def run_shadow(self, case: ShadowCase, *, candidate_model_ids: list[str],
                   legacy_tokens: int, legacy_cost: float, max_rounds: int,
                   correlation_id: str) -> Optional[PlannerShadowResult]:
        """Observe one task. Records a result or a failure; never raises."""
        request_id = f"shadow::{case.bug_id}"
        t0 = self._timer()
        timings: dict[str, float] = {}

        def elapsed_ms(since: float) -> float:
            return round((self._timer() - since) * 1000.0, 3)

        try:
            # --- build (adapter construction) ---
            t = self._timer()
            request, plan = build_request(
                case, candidate_model_ids=candidate_model_ids, max_rounds=max_rounds)
            timings["adapter_construction_ms"] = elapsed_ms(t)

            # --- estimate ---
            t = self._timer()
            try:
                estimate = self._estimator.estimate(request)
            except (UnboundedEstimateError, InconsistentEstimateError) as exc:
                return self._fail(request_id, correlation_id,
                                  ShadowFailureKind.INVALID_PLAN, "estimation", exc,
                                  t0, timings)
            except EstimationError as exc:
                return self._fail(request_id, correlation_id,
                                  ShadowFailureKind.ESTIMATOR_UNAVAILABLE, "estimation",
                                  exc, t0, timings)
            timings["estimation_ms"] = elapsed_ms(t)

            # --- price ---
            t = self._timer()
            projection = self._projector.project(
                estimate, model_ids=candidate_model_ids, at=self._now())
            timings["pricing_ms"] = elapsed_ms(t)

            # --- assemble the result (governance preview happens inside) ---
            result = self._build_result(
                case=case, request_id=request_id, correlation_id=correlation_id,
                candidate_model_ids=candidate_model_ids, estimate=estimate,
                projection=projection, plan=plan, legacy_tokens=legacy_tokens,
                legacy_cost=legacy_cost, t0=t0, timings=timings)
            self.sink.record_result(result)
            return result
        except Exception as exc:  # last-resort catch — the runtime must not see this
            return self._fail(request_id, correlation_id,
                              ShadowFailureKind.UNEXPECTED_INTERNAL_ERROR, "shadow",
                              exc, t0, timings)

    # ------------------------------------------------------------------ #
    # internals                                                           #
    # ------------------------------------------------------------------ #
    def _build_result(self, *, case: ShadowCase, request_id: str, correlation_id: str,
                      candidate_model_ids: list[str], estimate: UsageEstimate,
                      projection: CostProjection, plan, legacy_tokens: int,
                      legacy_cost: float, t0: float, timings: dict[str, float],
                      ) -> PlannerShadowResult:
        now = self._now()
        warnings: list[str] = []

        # token bands (model-independent)
        tokens = estimate.total_tokens
        legacy_in_range = tokens.best <= legacy_tokens <= tokens.worst
        token_div = tokens.expected - legacy_tokens
        token_pct = _fraction(Decimal(token_div), Decimal(legacy_tokens))

        # cost envelope across the priced candidates (fail-safe, mirrors the legacy
        # worst-case-across-candidates the circuit breaker computes)
        lines = [self._line(projection, mid) for mid in candidate_model_ids]
        priced = [ln for ln in lines if ln.available and ln.worst is not None]

        legacy_cost_money = Money(amount=Decimal(str(legacy_cost)))   # the one float boundary
        cost_best = cost_expected = cost_worst = None
        anchor_model_id: Optional[str] = None
        price_trust = None
        authoritative = False
        price_age: Optional[int] = None
        freshness_warning: Optional[str] = None
        legacy_cost_in_range: Optional[bool] = None
        cost_div_abs: Optional[Money] = None
        cost_div_pct: Optional[Decimal] = None

        if priced:
            cost_best = min((ln.best for ln in priced), key=lambda m: m.amount)
            cost_expected = max((ln.expected for ln in priced), key=lambda m: m.amount)
            cost_worst = max((ln.worst for ln in priced), key=lambda m: m.amount)
            anchor = max(priced, key=lambda ln: ln.worst.amount)   # the dearest worst case
            anchor_model_id = anchor.model_id
            price_trust = anchor.price_trust
            authoritative = anchor.authoritative_for_real_spend
            if anchor.price_verified_at:
                price_age = price_age_days(anchor.price_verified_at, as_of=now)
            legacy_cost_in_range = cost_best.amount <= legacy_cost_money.amount <= cost_worst.amount
            cost_div_abs = Money(amount=cost_expected.amount - legacy_cost_money.amount)
            cost_div_pct = _fraction(cost_div_abs.amount, legacy_cost_money.amount)
            if not authoritative:
                warnings.append(
                    f"cost is not authoritative for real spend: anchor price for "
                    f"{anchor_model_id!r} is {price_trust.value if price_trust else 'unknown'}")
        else:
            warnings.append(
                "no candidate had a usable price; the cost comparison is unavailable "
                "(the token comparison still stands)")

        if estimate.partial:
            warnings.append("the token estimate is partial; the divergence inherits that")
        warnings.extend(estimate.warnings)

        divergence = DivergenceReport(
            legacy_tokens=legacy_tokens,
            planner_tokens_best=tokens.best,
            planner_tokens_expected=tokens.expected,
            planner_tokens_worst=tokens.worst,
            legacy_tokens_in_planner_range=legacy_in_range,
            token_divergence_abs=token_div,
            token_divergence_pct=token_pct,
            legacy_cost=legacy_cost_money,
            planner_cost_best=cost_best,
            planner_cost_expected=cost_expected,
            planner_cost_worst=cost_worst,
            legacy_cost_in_planner_range=legacy_cost_in_range,
            cost_divergence_abs=cost_div_abs,
            cost_divergence_pct=cost_div_pct,
        )

        # --- governance preview (best effort; never fatal) ---
        t = self._timer()
        preview_available = False
        would_admit: Optional[bool] = None
        blocking_codes: list[str] = []
        ack_codes: list[str] = []
        if anchor_model_id is not None:
            try:
                admission = self._governance_preview(
                    case=case, plan=plan, estimate=estimate, projection=projection,
                    anchor_model_id=anchor_model_id, cost_worst=cost_worst, now=now)
                preview_available = True
                would_admit = admission.admitted
                blocking_codes = [c.code.value for c in admission.conditions.blocking]
                ack_codes = [c.code.value for c in admission.conditions.acknowledgeable]
            except Exception as exc:   # preview is optional; degrade, do not fail
                warnings.append(
                    f"governance preview unavailable ({type(exc).__name__}); the "
                    "estimate and divergence still stand")
        timings["governance_preview_ms"] = round((self._timer() - t) * 1000.0, 3)

        latency = ShadowLatency(
            adapter_construction_ms=timings.get("adapter_construction_ms", 0.0),
            estimation_ms=timings.get("estimation_ms", 0.0),
            pricing_ms=timings.get("pricing_ms", 0.0),
            governance_preview_ms=timings.get("governance_preview_ms", 0.0),
            persistence_ms=0.0,
            total_ms=round((self._timer() - t0) * 1000.0, 3),
        )

        return PlannerShadowResult(
            request_id=request_id,
            correlation_id=correlation_id,
            generated_at=now,
            candidate_model_ids=list(candidate_model_ids),
            selected_model=None,
            worst_case_model_id=anchor_model_id,
            assumptions=list(estimate.assumptions),
            confidence="unknown",
            completeness_ratio=str(estimate.completeness.ratio),
            estimate_partial=estimate.partial,
            divergence=divergence,
            per_candidate_costs=lines,
            price_trust=price_trust,
            authoritative_for_real_spend=authoritative,
            price_age_days=price_age,
            freshness_warning=freshness_warning,
            governance_preview_available=preview_available,
            would_admit_as_simulation=would_admit,
            blocking_condition_codes=blocking_codes,
            acknowledgeable_condition_codes=ack_codes,
            warnings=warnings,
            estimator_id=ESTIMATOR_ID,
            estimator_version=ESTIMATOR_VERSION,
            ruleset_version=RULESET_VERSION,
            pricing_ref=projection.pricing_ref,
            flags_fingerprint=self._flags_fingerprint,
            latency=latency,
        )

    def _governance_preview(self, *, case: ShadowCase, plan, estimate: UsageEstimate,
                            projection: CostProjection, anchor_model_id: str,
                            cost_worst: Optional[Money], now: str):
        """A SIMULATION admission against the worst-case candidate.

        The cap is sized above the projection on purpose: the orchestrator's real budget
        is token-denominated, and there is no money cap in P2a, so a budget breach here
        would be fabricated. The preview's value is the price-trust, freshness and
        reserve-eligibility conditions a real admission would carry — not an invented
        overspend. Purpose is SIMULATION, so nothing it yields can back real spend.
        """
        headroom = (cost_worst.amount if cost_worst is not None else Decimal("1")) \
            * Decimal("1000") + Decimal("1000")
        snapshot = BudgetSnapshot(
            budget_id=f"shadow-budget::{case.bug_id}",
            policy_id="shadow-simulation-policy",
            policy_hash="shadow-simulation-unhashed",
            currency="USD",
            hard_cap=Money(amount=headroom),
            effective_cap=Money(amount=headroom),
            actual_spend=Money.zero(),
            committed_spend=Money.zero(),
            snapshot_version=1,
            taken_at=now,
        )
        return self._guard.admit(
            admission_id=f"shadow-admission::{case.bug_id}",
            purpose=SpendPurpose.SIMULATION,
            plan=plan,
            snapshot=snapshot,
            projection=projection.for_model(anchor_model_id),
            estimate=estimate,
            as_of=now,
            evaluated_at=now,
        )

    @staticmethod
    def _line(projection: CostProjection, model_id: str) -> CandidateCostLine:
        proj = projection.for_model(model_id)
        if not proj.available or proj.range is None:
            return CandidateCostLine(
                model_id=model_id, available=False,
                unavailable_reason=proj.unavailable_reason)
        return CandidateCostLine(
            model_id=model_id,
            available=True,
            best=proj.range.best,
            expected=proj.range.expected,
            worst=proj.range.worst,
            price_trust=proj.price_trust,
            authoritative_for_real_spend=proj.authoritative_for_real_spend,
            price_verified_at=proj.price_verified_at,
            price_card_id=proj.price_card_id,
            warnings=list(proj.warnings),
        )

    def _fail(self, request_id: str, correlation_id: str, kind: ShadowFailureKind,
              phase: str, exc: Exception, t0: float, timings: dict[str, float],
              ) -> None:
        failure = ShadowFailure(
            request_id=request_id,
            correlation_id=correlation_id,
            generated_at=self._now(),
            kind=kind.value,
            phase=phase,
            message=f"{type(exc).__name__}: {exc}"[:500],
            flags_fingerprint=self._flags_fingerprint,
            latency=ShadowLatency(total_ms=round((self._timer() - t0) * 1000.0, 3)),
        )
        self.sink.record_failure(failure)
        return None
