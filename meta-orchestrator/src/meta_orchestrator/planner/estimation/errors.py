"""Estimation error contracts. All fail-closed.

There is no fallback in this module. No silent ``chars // 4``, no substituting another
model's rule, no borrowing a neighbouring price. When the estimator cannot produce a
defensible number it says so and stops — an estimate nobody can justify is worse than
no estimate, because a plan gets approved on it.
"""
from __future__ import annotations

from ..contracts.errors import PlannerError


class EstimationError(PlannerError):
    """Base for every estimation failure."""


class MissingRuleError(EstimationError):
    """No token rule or output profile covers this content family or profile id."""

    def __init__(self, what: str, key: str) -> None:
        self.what, self.key = what, key
        super().__init__(f"no {what} registered for {key!r} — refusing to substitute one")


class UnboundedEstimateError(EstimationError):
    """A worst case cannot be bounded, so no worst case may be reported.

    Raised for unbounded retries, and for output with neither a cap nor a profile. An
    invented finite bound would be the most dangerous kind of wrong: it looks like a
    limit and is not.
    """

    def __init__(self, stage_id: str, reason: str) -> None:
        self.stage_id, self.reason = stage_id, reason
        super().__init__(f"stage {stage_id!r} has no bounded worst case: {reason}")


class InconsistentEstimateError(EstimationError):
    """An estimate violates an invariant it is required to hold."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"inconsistent estimate: {detail}")


class CostProjectionUnavailableError(EstimationError):
    """Cost could not be projected, though the token estimate is still valid.

    Kept separate from the token path on purpose: a missing price must not destroy a
    perfectly good usage estimate.
    """

    def __init__(self, detail: str) -> None:
        super().__init__(f"cost projection unavailable: {detail}")
