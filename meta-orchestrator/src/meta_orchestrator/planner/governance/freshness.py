"""Price freshness — how old a price may be before it stops counting.

A price card records when it was verified. Without a policy saying how stale is too
stale, "verified 2026-07-15" is decoration: nothing ever consults it, and a year-old
figure admits exactly like a fresh one.

When a policy is set, an over-age price is **refused**. There is no fallback to the
stale value and no automatic lookup — refusing is the whole point, and quietly
substituting something would defeat it.

When no policy is set, that absence is itself reported, as an acknowledgeable warning.
Nobody may later claim the price was checked against the provider at execution time,
because it was not.

Dates are ISO-8601 (`YYYY-MM-DD`) and compared by simple day arithmetic. No clock is
read here; ``as_of`` is always passed in, so this stays deterministic.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from pydantic import BaseModel, ConfigDict, model_validator

from .conditions import ConditionCode
from .errors import PriceTooOldError


class PriceFreshnessPolicy(BaseModel):
    """How old a price may be. ``None`` everywhere means no policy — and a warning."""

    model_config = ConfigDict(frozen=True)

    #: Days. ``None`` means age is not checked.
    maximum_price_age_days: Optional[int] = None
    #: When true, a card with no verification date is refused outright.
    require_verification_date: bool = False

    @model_validator(mode="after")
    def _sane(self) -> "PriceFreshnessPolicy":
        if (self.maximum_price_age_days is not None
                and self.maximum_price_age_days < 0):
            raise ValueError("maximum_price_age_days cannot be negative")
        return self

    @property
    def is_configured(self) -> bool:
        return (self.maximum_price_age_days is not None
                or self.require_verification_date)


def _parse(day: str) -> Optional[date]:
    try:
        return date.fromisoformat(day[:10])
    except (ValueError, IndexError):
        return None


def price_age_days(verified_at: str, *, as_of: str) -> Optional[int]:
    """Age in days, or ``None`` when either date is unparseable."""
    verified, now = _parse(verified_at), _parse(as_of)
    if verified is None or now is None:
        return None
    return (now - verified).days


def check_freshness(policy: PriceFreshnessPolicy, *, model_id: str,
                    verified_at: str, as_of: str) -> Optional[ConditionCode]:
    """Return the condition this price raises, if any.

    ``PRICE_TOO_OLD`` is blocking. ``NO_PRICE_FRESHNESS_POLICY`` is acknowledgeable —
    a real judgement the approver is entitled to make, on the record.
    """
    if not policy.is_configured:
        return ConditionCode.NO_PRICE_FRESHNESS_POLICY

    if not verified_at.strip():
        if policy.require_verification_date:
            return ConditionCode.PRICE_TOO_OLD
        return ConditionCode.NO_PRICE_FRESHNESS_POLICY

    if policy.maximum_price_age_days is None:
        return None

    age = price_age_days(verified_at, as_of=as_of)
    if age is None:
        # An unparseable date is not evidence of freshness.
        return ConditionCode.PRICE_TOO_OLD
    if age > policy.maximum_price_age_days:
        return ConditionCode.PRICE_TOO_OLD
    return None


def assert_fresh(policy: PriceFreshnessPolicy, *, model_id: str, verified_at: str,
                 as_of: str) -> None:
    """Raise when the price is over-age. No fallback, no lookup."""
    if check_freshness(policy, model_id=model_id, verified_at=verified_at,
                       as_of=as_of) is ConditionCode.PRICE_TOO_OLD:
        raise PriceTooOldError(model_id, verified_at,
                               policy.maximum_price_age_days or 0)
