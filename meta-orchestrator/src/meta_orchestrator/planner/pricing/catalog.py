"""The product-owned pricing catalog — a versioned, static source of truth.

Every rate here is traceable to something already in this repository. Nothing was
fetched, searched for, averaged, or inferred from a neighbouring model:

* ``claude-opus-4-8`` and ``claude-haiku-4-5`` — from ``config.py``'s registry seed,
  whose own comment records them as ``(per-1M price / 1000)`` from the Claude API model
  table, verified 2026-07-15.
* ``claude-haiku-4-5`` is independently corroborated by the frozen §2 artifact
  ``corpus/s2_pricing.frozen.json`` (``$1.00`` in / ``$5.00`` out per MTok,
  ``pricing_verified_at: 2026-07-19``), which agrees exactly. That file is read as a
  document; it is not imported.
* ``mock-strong`` and ``mock-weak`` — offline fixtures from ``config.py``. Their prices
  are fictional by construction and are labelled as such.

**Cache rates are UNKNOWN for every model.** No cache price appears anywhere in this
repository, and inventing one — or assuming it equals the input rate, or zero — is
precisely what the rate statuses exist to prevent.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, model_validator

from .entities import PriceCard, PriceRate, PricingUnit, UsageCategory
from .errors import CatalogIntegrityError, PriceCardNotFoundError

#: Bump on any change to a rate. Quotes record it, so a historical quote stays
#: reproducible after the catalog moves on.
PRICING_VERSION = "product-pricing-v1"
CATALOG_VERSION = "catalog-2026-07-29"

_CONFIG_SOURCE = ("meta-orchestrator config.py registry seed (Claude API model table, "
                  "per-1M / 1000), verified 2026-07-15")
_S2_CORROBORATION = ("corroborated by corpus/s2_pricing.frozen.json "
                     "(content_hash 4ab7b2507474bffa, verified 2026-07-19)")
_MOCK_SOURCE = "meta-orchestrator config.py offline mock fixture — fictional prices"

_CACHE_UNKNOWN_NOTE = ("no cache read/write price exists anywhere in this repository; "
                       "recorded as UNKNOWN rather than assumed")


def _card(*, card_id: str, provider: str, model_id: str, snapshot: Optional[str],
          input_usd_per_mtok: str, output_usd_per_mtok: str, source: str,
          verified_at: str, notes: list[str], limitations: list[str]) -> PriceCard:
    """Build and seal one card. Rates are strings — never float literals."""
    return PriceCard(
        card_id=card_id,
        pricing_version=PRICING_VERSION,
        provider=provider,
        model_id=model_id,
        provider_model_snapshot=snapshot,
        currency="USD",
        unit=PricingUnit.USD_PER_MTOK,
        effective_from="2026-07-15",
        effective_until=None,
        rates={
            UsageCategory.INPUT: PriceRate.known(input_usd_per_mtok),
            UsageCategory.OUTPUT: PriceRate.known(output_usd_per_mtok),
            UsageCategory.CACHE_READ: PriceRate.unknown(),
            UsageCategory.CACHE_WRITE: PriceRate.unknown(),
        },
        source=source,
        source_verified_at=verified_at,
        notes=notes,
        limitations=limitations,
    ).sealed()


def default_price_cards() -> list[PriceCard]:
    """The four models registered in ``config.py``. No others, and none invented."""
    return [
        _card(
            card_id="anthropic/claude-opus-4-8@v1",
            provider="anthropic",
            model_id="claude-opus-4-8",
            snapshot="claude-opus-4-8",
            # config.py: price_per_1k_in=0.005 → $5.00/MTok; out=0.025 → $25.00/MTok
            input_usd_per_mtok="5.00",
            output_usd_per_mtok="25.00",
            source=_CONFIG_SOURCE,
            verified_at="2026-07-15",
            notes=["Opus 4.8 has no dated snapshot in the catalog — the alias is the id"],
            limitations=[_CACHE_UNKNOWN_NOTE],
        ),
        _card(
            card_id="anthropic/claude-haiku-4-5@v1",
            provider="anthropic",
            model_id="claude-haiku-4-5",
            snapshot="claude-haiku-4-5-20251001",
            # config.py: in=0.001 → $1.00/MTok; out=0.005 → $5.00/MTok.
            input_usd_per_mtok="1.00",
            output_usd_per_mtok="5.00",
            source=f"{_CONFIG_SOURCE}; {_S2_CORROBORATION}",
            verified_at="2026-07-19",
            notes=["the only model whose price is confirmed by two independent "
                   "in-repo sources that agree exactly"],
            limitations=[_CACHE_UNKNOWN_NOTE],
        ),
        _card(
            card_id="mock/mock-strong@v1",
            provider="mock",
            model_id="mock-strong",
            snapshot=None,
            # config.py: in=0.003 → $3.00/MTok; out=0.015 → $15.00/MTok
            input_usd_per_mtok="3.00",
            output_usd_per_mtok="15.00",
            source=_MOCK_SOURCE,
            verified_at="2026-07-15",
            notes=["offline fixture — not a real provider price"],
            limitations=[_CACHE_UNKNOWN_NOTE, "fictional; never use for a real budget"],
        ),
        _card(
            card_id="mock/mock-weak@v1",
            provider="mock",
            model_id="mock-weak",
            snapshot=None,
            # config.py: in=0.0005 → $0.50/MTok; out=0.0015 → $1.50/MTok
            input_usd_per_mtok="0.50",
            output_usd_per_mtok="1.50",
            source=_MOCK_SOURCE,
            verified_at="2026-07-15",
            notes=["offline fixture — not a real provider price"],
            limitations=[_CACHE_UNKNOWN_NOTE, "fictional; never use for a real budget"],
        ),
    ]


class PricingCatalog(BaseModel):
    """A versioned set of price cards, addressable by model and date.

    Never mutated in place. A rate change means a new card with a new
    ``effective_from`` and a bumped version, so a quote issued yesterday still
    re-derives to yesterday's figure.
    """

    model_config = ConfigDict(frozen=True)

    catalog_version: str = CATALOG_VERSION
    pricing_version: str = PRICING_VERSION
    cards: list[PriceCard]

    @model_validator(mode="after")
    def _integrity(self) -> "PricingCatalog":
        if not self.cards:
            raise CatalogIntegrityError("a catalog needs at least one price card")
        ids = [c.card_id for c in self.cards]
        if len(set(ids)) != len(ids):
            raise CatalogIntegrityError("duplicate card_id in catalog")
        for card in self.cards:
            card.verify_hash()
        # Two cards in force for one model at the same moment would make the effective
        # price a matter of list order.
        by_model: dict[str, list[PriceCard]] = {}
        for card in self.cards:
            by_model.setdefault(card.model_id, []).append(card)
        for model_id, cards in by_model.items():
            open_ended = [c for c in cards if c.effective_until is None]
            if len(open_ended) > 1:
                raise CatalogIntegrityError(
                    f"model {model_id!r} has {len(open_ended)} open-ended cards — "
                    "close the superseded one with effective_until")
        return self

    @classmethod
    def default(cls) -> "PricingCatalog":
        return cls(cards=default_price_cards())

    def card_for(self, model_id: str, *, at: Optional[str] = None) -> PriceCard:
        """The card in force for ``model_id``. Fails closed when there is none."""
        candidates = [c for c in self.cards if c.model_id == model_id]
        if not candidates:
            raise PriceCardNotFoundError(model_id, "not present in the catalog")
        if at is not None:
            candidates = [c for c in candidates if c.is_in_force(at)]
            if not candidates:
                raise PriceCardNotFoundError(model_id, f"no card in force at {at}")
        elif len(candidates) > 1:
            candidates = [c for c in candidates if c.effective_until is None]
            if len(candidates) != 1:
                raise PriceCardNotFoundError(
                    model_id, "several historical cards — pass `at` to disambiguate")
        return candidates[0]

    def card_by_hash(self, content_hash: str) -> PriceCard:
        """Re-derive a historical quote from the exact card it was priced under."""
        for card in self.cards:
            if card.content_hash == content_hash:
                return card
        raise PriceCardNotFoundError(content_hash, "no card with that content hash")

    def model_ids(self) -> list[str]:
        return sorted({c.model_id for c in self.cards})

    def pricing_ref(self) -> str:
        """Opaque identifier of the price set in force — satisfies ``PricingSource``."""
        return f"{self.catalog_version}/{self.pricing_version}"
