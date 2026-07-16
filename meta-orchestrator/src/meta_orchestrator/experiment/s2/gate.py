"""Continue/stop gate (Decision D + E) — reads ONLY stability / cost / harness / breaker.

The gate NEVER receives the sealed effect table. Its inputs are the pre-declared signals:
per-task pass/fail stability of A and C across the two pilot reps, whether the sign of (C−A)
reversed between reps (a boolean — the magnitude stays sealed), verifier determinism, real
cost within the circuit breaker, and harness health. This is what lets fold 1 double as both
pilot and official datum without the continue decision peeking at "does C look good".
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class StabilitySignals(BaseModel):
    n: int                          # #tasks with both reps present (per-condition)
    a_flips: int                    # A pass/fail flips across reps
    c_flips: int                    # C pass/fail flips across reps
    sign_reversed: bool             # did sign(C-A) reverse between reps? (boolean only)
    verifier_deterministic: bool    # no unexplained within-condition flips


class GateDecision(BaseModel):
    go: bool
    reasons: list[str] = Field(default_factory=list)


def continue_decision(
    stability: StabilitySignals,
    *,
    cost_within_breaker: bool,
    harness_healthy: bool,
    max_flips: int = 1,
) -> GateDecision:
    """Admit reps=1 for the full run iff every pre-declared stability condition holds."""
    reasons: list[str] = []
    if stability.a_flips > max_flips:
        reasons.append(f"A unstable: {stability.a_flips} flips > {max_flips}")
    if stability.c_flips > max_flips:
        reasons.append(f"C unstable: {stability.c_flips} flips > {max_flips}")
    if stability.sign_reversed:
        reasons.append("sign of C−A reversed between reps")
    if not stability.verifier_deterministic:
        reasons.append("verifier/environment nondeterminism detected")
    if not cost_within_breaker:
        reasons.append("real cost exceeded the circuit breaker")
    if not harness_healthy:
        reasons.append("harness health check failed")
    return GateDecision(go=not reasons, reasons=reasons or ["all stability gates passed"])
