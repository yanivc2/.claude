"""Model Gateway (SPEC §9): routes a call to an adapter with Registry-aware
fallback + retries, and computes cost from Registry pricing.
"""
from __future__ import annotations

from typing import Optional

from ..registry.registry import ModelRegistry
from .adapters import AdapterRequest, AdapterResponse, ModelAdapter


class GatewayResult:
    def __init__(self, model_used: str, response: AdapterResponse, cost: float) -> None:
        self.model_used = model_used
        self.response = response
        self.cost = cost
        self.tokens = response.tokens_in + response.tokens_out


class ModelGateway:
    def __init__(self, registry: ModelRegistry, adapter: ModelAdapter, max_attempts: int = 2) -> None:
        self._registry = registry
        self._adapter = adapter
        self._max_attempts = max_attempts

    def _cost(self, model_id: str, resp: AdapterResponse) -> float:
        spec = self._registry.get(model_id)
        return (resp.tokens_in / 1000.0) * spec.price_per_1k_in + (
            resp.tokens_out / 1000.0
        ) * spec.price_per_1k_out

    def run(self, model_id: str, request: AdapterRequest) -> GatewayResult:
        """Call the model, falling back to the Registry's fallback_model if unavailable."""
        spec = self._registry.get(model_id)
        target = model_id
        if not spec.availability and spec.fallback_model:
            target = spec.fallback_model  # SPEC §9 fallback

        last_exc: Optional[Exception] = None
        for _ in range(self._max_attempts):
            try:
                resp = self._adapter.complete(target, request)
                return GatewayResult(target, resp, self._cost(target, resp))
            except NotImplementedError:
                raise
            except Exception as exc:  # transient adapter error → retry (SPEC §9)
                last_exc = exc
        assert last_exc is not None
        raise last_exc
