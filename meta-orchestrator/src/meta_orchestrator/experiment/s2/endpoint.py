"""Endpoint binding (a5): prove the paid call actually leaves for the approved host.

A frozen price is worthless if the SDK can be pointed elsewhere. ``ANTHROPIC_BASE_URL`` (and the
Bedrock / Vertex switches) can redirect the client to a different gateway with different pricing, a
different provider, a different model mapping, or different usage accounting. This module resolves
the EFFECTIVE endpoint the SDK will use — reading the live ``client.base_url`` (which the SDK has
already resolved from ``ANTHROPIC_BASE_URL`` etc.), i.e. the HTTP-boundary host, not merely a config
guess — attests it, and blocks the call on anything other than ``https://api.anthropic.com`` for the
frozen provider + model.

The sanctioned transport-level agent proxy (``HTTPS_PROXY``) is NOT an endpoint override: it does
not change the API host, provider, pricing, or model mapping, and the frozen count_tokens traffic
already round-tripped through it to ``api.anthropic.com``. Only the API ``base_url`` host is checked.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Optional
from urllib.parse import urlparse

from pydantic import BaseModel

from .gates import GateError
from .pricing import PricingArtifact

# Alternate-gateway switches that must NOT be active for a frozen-endpoint run.
_ALT_GATEWAY_ENV = (
    "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
)


class EndpointAttestation(BaseModel):
    provider: str
    model: str
    scheme: str
    host: str
    base_url: str
    anthropic_base_url_env: Optional[str] = None     # raw override value, if the env var is set
    override_present: bool = False
    alt_gateway_env_active: list[str] = []
    content_hash: str = ""

    def compute_hash(self) -> str:
        payload = {k: v for k, v in self.model_dump().items() if k != "content_hash"}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    def sealed(self) -> "EndpointAttestation":
        return self.model_copy(update={"content_hash": self.compute_hash()})


def resolve_endpoint_attestation(*, provider: str, model: str, client: object = None,
                                 env: Optional[dict] = None) -> EndpointAttestation:
    """Attest the EFFECTIVE endpoint. Prefer the live SDK ``client.base_url`` (post-resolution)."""
    env = os.environ if env is None else env
    override = env.get("ANTHROPIC_BASE_URL")
    if client is not None and getattr(client, "base_url", None):
        base = str(client.base_url)
    else:
        base = override or env.get("META_ORCH_API_BASE_URL") or "https://api.anthropic.com"
    parsed = urlparse(base)
    alt = [k for k in _ALT_GATEWAY_ENV if (env.get(k) not in (None, "", "0", "false", "False"))]
    return EndpointAttestation(
        provider=provider, model=model, scheme=(parsed.scheme or ""),
        host=(parsed.hostname or ""), base_url=base,
        anthropic_base_url_env=override, override_present=override not in (None, ""),
        alt_gateway_env_active=alt).sealed()


def assert_endpoint_approved(att: EndpointAttestation, pricing: PricingArtifact) -> None:
    """Block the call unless the effective endpoint is exactly the approved host for this provider."""
    if att.content_hash != att.compute_hash():
        raise GateError("endpoint attestation hash mismatch (edited) — blocked")
    if att.alt_gateway_env_active:
        raise GateError(f"alternate gateway active {att.alt_gateway_env_active} "
                        "(Bedrock/Vertex/compat layer) — blocked; frozen run is direct-api only")
    if att.provider != pricing.provider:
        raise GateError(f"endpoint provider {att.provider!r} != frozen provider "
                        f"{pricing.provider!r} — blocked")
    if att.model != pricing.model:
        raise GateError(f"endpoint model {att.model!r} != frozen model {pricing.model!r} — blocked")
    if att.scheme != pricing.approved_scheme:
        raise GateError(f"endpoint scheme {att.scheme!r} != {pricing.approved_scheme!r} — blocked")
    if att.host != pricing.approved_host:
        raise GateError(f"endpoint host {att.host!r} != approved {pricing.approved_host!r} "
                        "(base_url override to a non-approved gateway) — blocked")
