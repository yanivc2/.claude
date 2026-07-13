"""Model Gateway (SPEC §9): one adapter interface + Registry-aware routing.

Phase 1 default is a deterministic mock adapter (offline). A real adapter can be
selected via config/env without changing callers.
"""
from .adapters import (
    AdapterRequest,
    AdapterResponse,
    AnthropicAdapter,
    MockAdapter,
    ModelAdapter,
    make_adapter,
)
from .gateway import ModelGateway

__all__ = [
    "ModelGateway",
    "ModelAdapter",
    "MockAdapter",
    "AnthropicAdapter",
    "make_adapter",
    "AdapterRequest",
    "AdapterResponse",
]
