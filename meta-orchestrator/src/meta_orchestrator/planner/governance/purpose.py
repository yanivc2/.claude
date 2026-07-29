"""Why a decision is being made — real money, or a rehearsal.

``allow_non_authoritative=True`` was a boolean, and a boolean does not say what it is
for. "Permit an untrustworthy price" and "this whole exercise is a simulation" are
different intents that happened to need the same relaxation, and collapsing them meant
an artifact could not later say which one it was.

``SpendPurpose`` names the intent instead. It travels into every artifact, so a
simulation result is recognisable as one forever after — and it is a **one-way**
label: a simulation authorization can never be promoted to real spend. Crossing over
requires a fresh admission and a fresh approval, because the checks that were skipped
were skipped, and no amount of relabelling performs them retroactively.
"""
from __future__ import annotations

from enum import Enum

from ..pricing.entities import BILLABLE_TRUST, PriceTrust

#: Stamped on every artifact produced under SIMULATION.
NOT_ELIGIBLE_MARKER = "NOT_ELIGIBLE_FOR_REAL_SPEND"


class SpendPurpose(str, Enum):
    """What a governance decision is for."""

    #: Money will actually be spent. Every check applies at full strength.
    REAL_SPEND = "real_spend"
    #: A rehearsal. Untrusted prices are permitted, and every artifact is marked.
    SIMULATION = "simulation"

    @property
    def is_real(self) -> bool:
        return self is SpendPurpose.REAL_SPEND


def trust_permitted(purpose: SpendPurpose, trust: PriceTrust) -> bool:
    """Whether a price of this trust class may be used for this purpose."""
    if purpose.is_real:
        return trust in BILLABLE_TRUST
    return True


def eligibility_markers(purpose: SpendPurpose) -> list[str]:
    """Markers to stamp on an artifact produced under ``purpose``."""
    return [] if purpose.is_real else [NOT_ELIGIBLE_MARKER]


def assert_not_promotable(approved_purpose: SpendPurpose,
                          requested_purpose: SpendPurpose) -> None:
    """Refuse to reuse a simulation decision for real spend.

    The asymmetry is deliberate: real-spend authority covers a rehearsal (every check
    that mattered was made), but rehearsal authority covers nothing, because the
    checks were relaxed by design.
    """
    from .errors import PurposeMismatchError

    if requested_purpose.is_real and not approved_purpose.is_real:
        raise PurposeMismatchError(
            "this decision was made under SIMULATION and cannot authorise real spend — "
            "a fresh admission and approval are required")
