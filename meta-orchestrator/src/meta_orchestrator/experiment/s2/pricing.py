"""Frozen pricing artifact (a5): the SINGLE source of cost truth, Decimal-only.

Closes the a5 gap. Before a5 the ``$1 / $5`` per-MTok constants lived only in the projection
script and were bound to nothing: a silent price change — or an ``ANTHROPIC_BASE_URL`` override
pointing the SDK at a different gateway (different pricing / provider / model mapping / usage
accounting / a proxy that retries or transforms) — would proceed on the OLD estimate. Here the
prices and the approved endpoint live in ONE frozen, content-addressed artifact; every projection,
maximum-exposure figure and budget reservation is DERIVED from it (``Decimal``, never ``float``);
and its hash is bound into Gate 1 and the authorization anchor, so any change invalidates both and
forces re-projection + re-authorization.

Honest scope: this proves the experiment was authorized under a SPECIFIC published price on a
specific date, and that every cost figure is derived consistently from it — NOT that Anthropic did
not change a price a minute before the call. Post-call reconciliation of actual usage/cost covers
the residual; there is no live price scraper (unneeded for a single-operator ~$30 run).
"""
from __future__ import annotations

import hashlib
import json
import os
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel

from .gates import GateError

FROZEN_PRICING_FILENAME = "s2_pricing.frozen.json"
PRICING_SCHEMA_VERSION = "s2-pricing-v1"
_MTOK = Decimal(1_000_000)


class PricingArtifact(BaseModel):
    """The frozen, content-addressed price + approved endpoint. Prices are STRINGS → ``Decimal``."""

    pricing_schema_version: str
    provider: str
    model: str
    input_usd_per_mtok: str                 # kept as a string so the source of truth is exact
    output_usd_per_mtok: str
    approved_scheme: str
    approved_host: str
    pricing_source: str
    pricing_verified_at: str
    content_hash: str = ""

    def compute_hash(self) -> str:
        payload = {k: v for k, v in self.model_dump().items() if k != "content_hash"}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    def sealed(self) -> "PricingArtifact":
        return self.model_copy(update={"content_hash": self.compute_hash()})

    # --- Decimal rates (per single token) ---
    def input_rate_per_token(self) -> Decimal:
        return Decimal(self.input_usd_per_mtok) / _MTOK

    def output_rate_per_token(self) -> Decimal:
        return Decimal(self.output_usd_per_mtok) / _MTOK


def call_cost_usd(pricing: PricingArtifact, *, input_tokens: int, output_tokens: int) -> Decimal:
    """Exact per-call cost, DERIVED from the frozen artifact (Decimal). No float, no local rate."""
    return (Decimal(int(input_tokens)) * pricing.input_rate_per_token()
            + Decimal(int(output_tokens)) * pricing.output_rate_per_token())


def max_call_cost_usd(pricing: PricingArtifact, *, input_tokens: int, max_output_tokens: int
                      ) -> Decimal:
    """Maximum exposure of one call: full ``max_output_tokens`` billed as output (thinking incl.)."""
    return call_cost_usd(pricing, input_tokens=input_tokens, output_tokens=max_output_tokens)


def load_frozen_pricing(corpus_dir: str) -> PricingArtifact:
    """Load + verify the frozen pricing artifact. Blocks on missing / stale-hash / wrong-schema."""
    path = os.path.join(corpus_dir, FROZEN_PRICING_FILENAME)
    if not os.path.exists(path):
        raise GateError(f"frozen pricing artifact missing: {path} — Gate 1 cannot be production-valid")
    art = PricingArtifact(**json.load(open(path)))
    if art.pricing_schema_version != PRICING_SCHEMA_VERSION:
        raise GateError(f"pricing schema {art.pricing_schema_version!r} != {PRICING_SCHEMA_VERSION!r}")
    if art.content_hash != art.compute_hash():
        raise GateError("pricing artifact content_hash mismatch (stale or hand-edited) — Gate 1 void")
    return art


def assert_pricing_matches(pricing: PricingArtifact, *, expected_hash: str,
                           expected_input_usd_per_mtok: str, expected_output_usd_per_mtok: str,
                           expected_model: str, expected_provider: str) -> None:
    """Block on ANY drift from the values Gate 1 was authorized under (price / model / provider)."""
    if pricing.content_hash != expected_hash:
        raise GateError("pricing artifact hash drift — re-project and re-authorize")
    if Decimal(pricing.input_usd_per_mtok) != Decimal(expected_input_usd_per_mtok):
        raise GateError("input price drift — re-project and re-authorize")
    if Decimal(pricing.output_usd_per_mtok) != Decimal(expected_output_usd_per_mtok):
        raise GateError("output price drift — re-project and re-authorize")
    if pricing.model != expected_model:
        raise GateError("pricing model drift — re-project and re-authorize")
    if pricing.provider != expected_provider:
        raise GateError("pricing provider drift — re-project and re-authorize")


def build_pricing_artifact(*, provider: str, model: str, input_usd_per_mtok: str,
                           output_usd_per_mtok: str, pricing_source: str, pricing_verified_at: str,
                           approved_scheme: str = "https", approved_host: str = "api.anthropic.com",
                           ) -> PricingArtifact:
    """Construct + seal a pricing artifact (used once to freeze ``s2_pricing.frozen.json``)."""
    return PricingArtifact(
        pricing_schema_version=PRICING_SCHEMA_VERSION, provider=provider, model=model,
        input_usd_per_mtok=input_usd_per_mtok, output_usd_per_mtok=output_usd_per_mtok,
        approved_scheme=approved_scheme, approved_host=approved_host,
        pricing_source=pricing_source, pricing_verified_at=pricing_verified_at).sealed()


def frozen_pricing_hash(corpus_dir: Optional[str]) -> str:
    """Best-effort content hash of the frozen pricing file (for ``collect_frozen_hashes``)."""
    if not corpus_dir:
        return "absent"
    path = os.path.join(corpus_dir, FROZEN_PRICING_FILENAME)
    if not os.path.exists(path):
        return "absent"
    try:
        return str(json.load(open(path)).get("content_hash", "unavailable"))
    except Exception:
        return "unreadable"
