"""Token counters with ISOLATED, provenance-verified caches (P0.2).

The review's failure mode: an offline-proxy count cached under a request hash is later returned to
a caller that asked for a "real" count, and the resulting artifact is mislabeled
``anthropic_count_tokens``. The guard is namespace isolation + provenance verification:

  * proxy and real counters use SEPARATE cache namespaces (keyed by source);
  * every cache entry stores its own provenance (source, counter version, model, canonical hash);
  * a read VERIFIES the stored provenance matches the requested source — it never trusts the
    caller's requested mode;
  * a proxy miss can never fall through to (or satisfy) the real namespace, and vice-versa.

Only a ``CountResult`` whose ``source == REAL_SOURCE`` may open a production gate.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel

from .b1_selector import PROXY_SOURCE, REAL_SOURCE, local_token_estimate
from .canonical import CanonicalS2Request

PROXY_COUNTER_VERSION = "proxy-local-v1"
REAL_COUNTER_VERSION = "anthropic-count_tokens"


class CountResult(BaseModel):
    tokens: int
    source: str                 # offline_proxy | anthropic_count_tokens
    counter_version: str
    model: str
    canonical_hash: str
    api_version: str = ""


class CounterProvenanceError(RuntimeError):
    """A cache entry's stored provenance did not match the requested source (isolation breach)."""


class _BaseCounter:
    source = ""
    version = ""

    def __init__(self) -> None:
        self._cache: dict[str, CountResult] = {}

    def _key(self, req: CanonicalS2Request) -> str:
        # namespace is implicit (per-instance cache) AND explicit in the key.
        return f"{self.source}|{self.version}|{req.model}|{req.canonical_hash()}"

    def _compute(self, req: CanonicalS2Request) -> int:            # pragma: no cover - overridden
        raise NotImplementedError

    def count(self, req: CanonicalS2Request) -> CountResult:
        key = self._key(req)
        hit = self._cache.get(key)
        if hit is not None:
            if hit.source != self.source:                          # provenance must match
                raise CounterProvenanceError(
                    f"cache entry source {hit.source!r} != counter source {self.source!r}")
            return hit
        res = CountResult(tokens=self._compute(req), source=self.source,
                          counter_version=self.version, model=req.model,
                          canonical_hash=req.canonical_hash(), api_version=self._api_version())
        self._cache[key] = res
        return res

    def _api_version(self) -> str:
        return ""


class ProxyTokenCounter(_BaseCounter):
    """Deterministic offline proxy over the count_tokens payload. NOT production-valid."""

    source = PROXY_SOURCE
    version = PROXY_COUNTER_VERSION

    def _compute(self, req: CanonicalS2Request) -> int:
        import json
        return local_token_estimate(json.dumps(req.count_tokens_kwargs(), sort_keys=True))


class AnthropicTokenCounter(_BaseCounter):
    """Real counter (pilot env): calls ``client.messages.count_tokens`` (free, but SDK+network).

    Never falls back to the proxy: a failure raises, so a missing real count BLOCKS rather than
    silently approximating.
    """

    source = REAL_SOURCE
    version = REAL_COUNTER_VERSION

    def __init__(self, client: Any, *, api_version: str = "") -> None:
        super().__init__()
        self._client = client
        self._api = api_version

    def _api_version(self) -> str:
        return self._api

    def _compute(self, req: CanonicalS2Request) -> int:
        resp = self._client.messages.count_tokens(**req.count_tokens_kwargs())
        return int(getattr(resp, "input_tokens", None) if hasattr(resp, "input_tokens")
                   else resp["input_tokens"])


def is_production_count(result: CountResult) -> bool:
    return result.source == REAL_SOURCE and result.counter_version == REAL_COUNTER_VERSION
