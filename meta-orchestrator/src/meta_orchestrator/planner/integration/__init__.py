"""Runtime shadow integration (P2a) — the Planner as an observer of the orchestrator.

This is the **only** part of the Planner the orchestrator is allowed to know about. The
orchestrator imports from here and nothing deeper: not persistence, not the governance
store, not a budget service. Everything the Planner does behind this boundary — estimate,
price, preview — is reached through :class:`ShadowRunner`, so the orchestrator holds a
narrow interface and no Planner logic of its own.

What P2a permits, stated once:

* The Planner runs only when ``planner_enabled`` **and** ``planner_shadow_mode`` are on.
* It observes; it never changes the estimate the circuit breaker acts on, the model, the
  budget, the routing, or the user-visible result.
* It spends nothing, reserves nothing, opens no database (the default sink is in memory),
  makes no provider call, and reads no clock except the one injected for a timestamp.
* Enforcement and real spend are refused at construction — an observer cannot be promoted
  by a stray flag.

Rollback is one flag: ``planner_enabled=False`` and this package is never constructed.
"""
from __future__ import annotations

from .case import ShadowCase
from .errors import (
    IntegrationError,
    ShadowConfigError,
    ShadowFailureKind,
)
from .request_adapter import (
    build_plan_snapshot,
    build_request,
    build_stages,
    code_metrics,
)
from .result import (
    CandidateCostLine,
    DivergenceReport,
    InMemoryShadowSink,
    PlannerShadowResult,
    ShadowFailure,
    ShadowLatency,
    ShadowSink,
)
from .shadow_runner import ShadowRunner

__all__ = [
    "ShadowRunner",
    "ShadowSink",
    "InMemoryShadowSink",
    "PlannerShadowResult",
    "ShadowFailure",
    "ShadowLatency",
    "DivergenceReport",
    "CandidateCostLine",
    "ShadowCase",
    "IntegrationError",
    "ShadowConfigError",
    "ShadowFailureKind",
    "build_request",
    "build_stages",
    "build_plan_snapshot",
    "code_metrics",
]
