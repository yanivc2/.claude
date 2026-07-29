"""Legacy compatibility boundary: ``ModelSpec`` (float) → ``PriceCard`` (Decimal).

**This is the one place in the Planner where a float is allowed to exist**, and it is
allowed only because ``ModelSpec.price_per_1k_in/out`` are declared ``float`` in
``models.py`` and P1a is not authorised to change them.

The conversion goes through ``Decimal(str(x))``, never ``Decimal(x)``. The difference
is not cosmetic:

    Decimal(0.005)       -> 0.005000000000000000104083408558...
    Decimal(str(0.005))  -> 0.005

``Decimal(float)`` faithfully reproduces the binary approximation the float already
is; ``str()`` first renders the shortest decimal that round-trips, which is the number
a human wrote in ``config.py``.

**The underlying risk is not closed.** As long as the source fields are ``float``, a
price that cannot be written exactly in binary has already lost precision before this
adapter sees it. This narrows the blast radius; it does not remove it. Closing it
means changing ``ModelSpec``, which is P1b+ work.
"""
from __future__ import annotations

from decimal import Decimal

from ...models import ModelSpec
from .entities import PriceCard, PriceRate, PriceTrust, PricingUnit, UsageCategory

#: config.py stores per-1k prices; cards are per-MTok, the unit providers publish in.
_PER_1K_TO_PER_MTOK = Decimal(1000)

LEGACY_BOUNDARY_NOTE = (
    "legacy compatibility boundary: derived from ModelSpec float fields via "
    "Decimal(str(x)); the source fields remain float and the precision risk is "
    "narrowed, not eliminated"
)


def _rate_from_legacy_float(price_per_1k: float) -> PriceRate:
    """Convert one per-1k float to a per-MTok string rate, as exactly as possible."""
    if not isinstance(price_per_1k, (int, float)):
        raise TypeError(f"expected a numeric legacy price, got {type(price_per_1k)!r}")
    if price_per_1k < 0:
        raise ValueError("a legacy price cannot be negative")
    per_mtok = Decimal(str(price_per_1k)) * _PER_1K_TO_PER_MTOK
    # normalize() drops trailing zeros so the same price always renders identically;
    # without it 5.000 and 5.0 would hash to different cards.
    return PriceRate.known(str(per_mtok.normalize()))


def price_card_from_model_spec(spec: ModelSpec, *, pricing_version: str,
                               trust: PriceTrust = PriceTrust.UNVERIFIED,
                               effective_from: str = "2026-07-15") -> PriceCard:
    """Build a sealed card from a registry ``ModelSpec``.

    Cache rates come out ``UNKNOWN``: ``ModelSpec`` has no cache fields at all, and
    absence of a field is not evidence of a zero price.
    """
    return PriceCard(
        card_id=f"legacy/{spec.provider}/{spec.model_id}@{pricing_version}",
        pricing_version=pricing_version,
        provider=spec.provider,
        model_id=spec.model_id,
        provider_model_snapshot=spec.provider_model_snapshot,
        currency="USD",
        unit=PricingUnit.USD_PER_MTOK,
        effective_from=effective_from,
        effective_until=None,
        rates={
            UsageCategory.INPUT: _rate_from_legacy_float(spec.price_per_1k_in),
            UsageCategory.OUTPUT: _rate_from_legacy_float(spec.price_per_1k_out),
            UsageCategory.CACHE_READ: PriceRate.unknown(),
            UsageCategory.CACHE_WRITE: PriceRate.unknown(),
        },
        trust=trust,
        source=f"ModelSpec registry entry for {spec.model_id!r}",
        source_verified_at=spec.last_verified or effective_from,
        notes=[LEGACY_BOUNDARY_NOTE],
        limitations=[
            "ModelSpec carries no cache rates; both are UNKNOWN",
            "source fields are float — see module docstring",
        ],
    ).sealed()
