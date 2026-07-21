"""Shared final-round lifecycle contract for BOTH runners (DEFECT-6).

Once Round 2 opens it becomes the FINAL round; Round 1's applied patch is NO LONGER an eligible final
graded repair. Each runner resets its workspace to the frozen buggy pre-image before R2 (and after any
terminal-failure round) so a failed final round grades the BUGGY source — never a silent fallback to
R1. This module owns the ONE rule that decides WHICH state may be graded; it deliberately does NOT
decide verification SCHEDULING, because the two runners keep different (and both correct) policies:

  * paid ``real_canary``   — verify iff a valid final patch exists (hidden_verify_count ∈ {0, 1});
  * offline ``run_attempt`` — verify EXACTLY ONCE on the resolved final state (its frozen contract).

Both, however, must agree that after R2 opens the graded state is R2's patch (if valid+applied) or the
buggy pre-image — never R1's. Encoding that single rule here keeps the two paths from silently
diverging again.
"""
from __future__ import annotations

from enum import Enum


class GradedState(str, Enum):
    BUGGY = "buggy"                 # no valid applied patch in the final round → grade the buggy source
    R1_PATCH = "r1_patch"           # single-round success (R2 never opened)
    R2_PATCH = "r2_patch"           # R2 produced a valid+applied patch


class LifecycleViolation(RuntimeError):
    """A final-round lifecycle invariant was broken (e.g. R1's patch resolved as final after R2 opened)."""


def resolve_final_graded_state(*, r2_opened: bool, final_round_index: int,
                               final_round_valid_applied: bool) -> GradedState:
    """The ONE state a runner may grade after the loop.

    - a failed final round (``final_round_valid_applied`` False) → BUGGY (never a prior round's patch);
    - a valid+applied final round → that round's patch (R1_PATCH iff R2 never opened, else R2_PATCH).

    Fail-closed: R1_PATCH is impossible once R2 opened — that would be the DEFECT-6 silent fallback."""
    if not final_round_valid_applied:
        state = GradedState.BUGGY
    elif final_round_index >= 2:
        state = GradedState.R2_PATCH
    else:
        state = GradedState.R1_PATCH
    if r2_opened and state == GradedState.R1_PATCH:
        raise LifecycleViolation(
            "R1's patch resolved as the final graded state AFTER R2 opened — forbidden fallback")
    return state


def hidden_verify_allowed(state: GradedState) -> bool:
    """Paid-path policy: a hidden verify is meaningful only when the final graded state is a real
    applied patch (never the buggy pre-image). The offline sim ignores this and always verifies once,
    on whatever ``resolve_final_graded_state`` says the graded state is."""
    return state != GradedState.BUGGY
