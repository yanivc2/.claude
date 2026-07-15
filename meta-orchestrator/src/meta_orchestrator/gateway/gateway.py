"""Model Gateway (SPEC §9): routes a call to an adapter with Registry-aware
fallback + retries, and computes cost from Registry pricing.

Experiment lock (v2 §5): when constructed with ``experiment_mode=True``, the
gateway performs NO cross-model fallback. If the locked model is unavailable or
its call keeps failing, the run raises loudly (``ModelUnavailableError`` /
the adapter's own exception) instead of silently substituting another model — a
silent fallback would be an undetectable confound in a learning experiment.
"""
from __future__ import annotations

from typing import Optional

from ..registry.registry import ModelRegistry
from .adapters import AdapterRequest, AdapterResponse, ModelAdapter


class ModelUnavailableError(RuntimeError):
    """Raised in experiment mode when the locked model is unavailable (no fallback)."""


class GatewayResult:
    def __init__(
        self,
        model_used: str,
        response: AdapterResponse,
        cost: float,
        provider_model: Optional[str] = None,
        experiment_mode: bool = False,
    ) -> None:
        self.model_used = model_used                 # logical/registry id
        self.provider_model = provider_model or model_used  # exact snapshot sent to the API
        self.experiment_mode = experiment_mode       # was the no-fallback lock active?
        self.response = response
        self.cost = cost
        self.tokens = response.tokens_in + response.tokens_out


class ModelGateway:
    def __init__(
        self,
        registry: ModelRegistry,
        adapter: ModelAdapter,
        max_attempts: int = 2,
        experiment_mode: bool = False,
    ) -> None:
        self._registry = registry
        self._adapter = adapter
        self._max_attempts = max_attempts
        self._experiment_mode = experiment_mode

    def _cost(self, model_id: str, resp: AdapterResponse) -> float:
        spec = self._registry.get(model_id)
        return (resp.tokens_in / 1000.0) * spec.price_per_1k_in + (
            resp.tokens_out / 1000.0
        ) * spec.price_per_1k_out

    def run(self, model_id: str, request: AdapterRequest) -> GatewayResult:
        """Call the model. In normal mode, fall back to the Registry's fallback_model
        if the target is unavailable. In experiment mode, NEVER fall back — an
        unavailable locked model raises ``ModelUnavailableError`` (loud, not silent)."""
        spec = self._registry.get(model_id)
        target = model_id
        if not spec.availability:
            if self._experiment_mode:
                raise ModelUnavailableError(
                    f"experiment_mode: locked model {model_id!r} is unavailable and "
                    "fallback is disabled (a silent fallback would be a confound)"
                )
            if spec.fallback_model:
                target = spec.fallback_model  # SPEC §9 fallback (normal mode only)

        provider_model = self._registry.get(target).provider_model_snapshot or target

        last_exc: Optional[Exception] = None
        for _ in range(self._max_attempts):
            try:
                resp = self._adapter.complete(target, request, provider_model=provider_model)
                return GatewayResult(
                    target, resp, self._cost(target, resp),
                    provider_model=provider_model, experiment_mode=self._experiment_mode,
                )
            except NotImplementedError:
                raise
            except Exception as exc:  # transient adapter error → retry same model (SPEC §9)
                last_exc = exc
        assert last_exc is not None
        raise last_exc
