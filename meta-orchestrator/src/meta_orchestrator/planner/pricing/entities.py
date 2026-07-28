"""Pricing domain: what a rate is, what a price card is, and what usage looks like.

Product-owned. This module deliberately does **not** import
``experiment/s2/pricing.py``: that artifact is frozen and hash-bound into §2's
authorisation chain, so depending on it — or refactoring a shared base out of it —
would couple product code to a research audit trail. Its *patterns* are reused
(``Decimal``-only, prices held as strings, content-addressed cards, drift detection);
its code is not.

Three statuses, and the distinction between them is the point:

``KNOWN``        the source states a rate. It may legitimately be zero.
``UNKNOWN``      we do not have a rate. Never treated as zero.
``UNSUPPORTED``  the provider does not offer this category for this model.
"""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .errors import CatalogIntegrityError

#: Providers publish per-million-token prices, and the frozen §2 artifact stores them
#: that way too. Keeping the same unit means a rate can be compared with a published
#: figure without arithmetic in between.
TOKENS_PER_MTOK = Decimal(1_000_000)


class PricingUnit(str, Enum):
    USD_PER_MTOK = "usd_per_mtok"


class UsageCategory(str, Enum):
    """The billed categories. Separate fields because they are separate line items."""

    INPUT = "input"
    OUTPUT = "output"
    CACHE_READ = "cache_read"
    CACHE_WRITE = "cache_write"


class RateStatus(str, Enum):
    KNOWN = "known"
    UNKNOWN = "unknown"
    UNSUPPORTED = "unsupported"


class PriceRate(BaseModel):
    """One rate for one usage category.

    ``amount`` is a *string* so the source of truth stays exact and reviewable, and is
    converted to ``Decimal`` only on use. It must be absent unless the status is
    ``KNOWN`` — an amount attached to an unknown rate is the ambiguity this type
    exists to remove.
    """

    model_config = ConfigDict(frozen=True)

    status: RateStatus
    amount: Optional[str] = None
    unit: PricingUnit = PricingUnit.USD_PER_MTOK

    @field_validator("amount")
    @classmethod
    def _exact(cls, v: Optional[str]) -> Optional[str]:
        # The ``str`` annotation already rejects a float outright — pydantic does not
        # coerce numeric types to str — so this validator only has to check that the
        # string is a well-formed, non-negative decimal.
        if v is None:
            return v
        try:
            parsed = Decimal(v)
        except Exception as exc:
            raise ValueError(f"PriceRate.amount {v!r} is not a decimal") from exc
        if parsed < 0:
            raise ValueError("a rate cannot be negative")
        return v

    @model_validator(mode="after")
    def _status_matches_amount(self) -> "PriceRate":
        if self.status is RateStatus.KNOWN and self.amount is None:
            raise ValueError("a KNOWN rate must carry an amount")
        if self.status is not RateStatus.KNOWN and self.amount is not None:
            raise ValueError(f"a {self.status.value} rate must not carry an amount")
        return self

    @classmethod
    def known(cls, amount: str) -> "PriceRate":
        return cls(status=RateStatus.KNOWN, amount=amount)

    @classmethod
    def unknown(cls) -> "PriceRate":
        return cls(status=RateStatus.UNKNOWN)

    @classmethod
    def unsupported(cls) -> "PriceRate":
        return cls(status=RateStatus.UNSUPPORTED)

    @property
    def is_known(self) -> bool:
        return self.status is RateStatus.KNOWN

    def per_token(self) -> Decimal:
        """Exact price of one token. Only valid on a KNOWN rate."""
        if not self.is_known:
            raise ValueError(f"cannot take a per-token rate from a {self.status.value} rate")
        return Decimal(self.amount) / TOKENS_PER_MTOK  # type: ignore[arg-type]


class TokenUsage(BaseModel):
    """Counts to be priced. Given, never guessed — P1a does not estimate usage."""

    model_config = ConfigDict(frozen=True)

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    @model_validator(mode="after")
    def _non_negative(self) -> "TokenUsage":
        for field in ("input_tokens", "output_tokens",
                      "cache_read_tokens", "cache_write_tokens"):
            if getattr(self, field) < 0:
                raise ValueError(f"TokenUsage.{field} cannot be negative")
        return self

    def by_category(self) -> dict[UsageCategory, int]:
        return {
            UsageCategory.INPUT: self.input_tokens,
            UsageCategory.OUTPUT: self.output_tokens,
            UsageCategory.CACHE_READ: self.cache_read_tokens,
            UsageCategory.CACHE_WRITE: self.cache_write_tokens,
        }

    @property
    def total_tokens(self) -> int:
        return sum(self.by_category().values())


class PriceCard(BaseModel):
    """Everything needed to price one model, pinned to a version and a source.

    ``content_hash`` makes the card addressable: a quote that records the hash can be
    reproduced later even after the catalog has moved on, and any edit to a card
    changes the hash rather than silently rewriting history.
    """

    model_config = ConfigDict(frozen=True)

    card_id: str
    pricing_version: str
    provider: str
    model_id: str                                 # logical registry id
    provider_model_snapshot: Optional[str] = None  # exact string sent to the provider
    currency: str = "USD"
    unit: PricingUnit = PricingUnit.USD_PER_MTOK

    effective_from: str                            # ISO-8601 date
    effective_until: Optional[str] = None          # None = still in force

    rates: dict[UsageCategory, PriceRate]

    source: str                                    # where the numbers came from
    source_verified_at: str                        # ISO-8601 date
    notes: list[str] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    content_hash: str = ""

    @model_validator(mode="after")
    def _complete(self) -> "PriceCard":
        if len(self.currency) != 3 or not self.currency.isupper():
            raise ValueError(f"currency must be a 3-letter uppercase code, got {self.currency!r}")
        missing = set(UsageCategory) - set(self.rates)
        if missing:
            raise ValueError(
                f"card {self.card_id!r} omits {sorted(c.value for c in missing)} — every "
                "category must be stated, as KNOWN, UNKNOWN or UNSUPPORTED"
            )
        for rate in self.rates.values():
            if rate.unit is not self.unit:
                raise ValueError(f"card {self.card_id!r} mixes pricing units")
        if not self.source.strip():
            raise ValueError("a price card must name its source")
        if self.effective_until is not None and self.effective_until <= self.effective_from:
            raise ValueError("effective_until must be after effective_from")
        return self

    def canonical_payload(self) -> dict[str, Any]:
        """Stable dict for hashing and serialization. Excludes the hash itself."""
        return {
            "card_id": self.card_id,
            "pricing_version": self.pricing_version,
            "provider": self.provider,
            "model_id": self.model_id,
            "provider_model_snapshot": self.provider_model_snapshot,
            "currency": self.currency,
            "unit": self.unit.value,
            "effective_from": self.effective_from,
            "effective_until": self.effective_until,
            "rates": {
                c.value: {"status": self.rates[c].status.value,
                          "amount": self.rates[c].amount,
                          "unit": self.rates[c].unit.value}
                for c in sorted(self.rates, key=lambda c: c.value)
            },
            "source": self.source,
            "source_verified_at": self.source_verified_at,
            "notes": self.notes,
            "limitations": self.limitations,
        }

    def compute_hash(self) -> str:
        blob = json.dumps(self.canonical_payload(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()[:16]

    def sealed(self) -> "PriceCard":
        return self.model_copy(update={"content_hash": self.compute_hash()})

    def verify_hash(self) -> None:
        """Raise if the card was hand-edited after sealing."""
        if self.content_hash and self.content_hash != self.compute_hash():
            raise CatalogIntegrityError(
                f"price card {self.card_id!r} hash mismatch — stale or hand-edited")

    def rate_for(self, category: UsageCategory) -> PriceRate:
        return self.rates[category]

    def is_in_force(self, at: str) -> bool:
        """Whether this card applies on ``at`` (ISO-8601 date, compared lexically)."""
        if at < self.effective_from:
            return False
        return self.effective_until is None or at < self.effective_until

    def known_categories(self) -> list[UsageCategory]:
        return [c for c in UsageCategory if self.rates[c].is_known]

    def unresolved_categories(self) -> list[UsageCategory]:
        """Categories that cannot be priced — UNKNOWN or UNSUPPORTED."""
        return [c for c in UsageCategory if not self.rates[c].is_known]
