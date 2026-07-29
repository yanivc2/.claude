"""Failure taxonomy for the shadow integration (P2a).

The integration boundary exists to keep a Planner failure from ever reaching the
runtime it observes. But "never crash the orchestrator" must not become "swallow the
failure": every failure is classified and recorded, so a shadow that stopped producing
results is visible rather than silent.

The distinction between kinds is deliberate. "The estimator could not run" and "the
price was missing" and "something we did not anticipate threw" are different findings,
and collapsing them into one ``except Exception`` would hide which part of the Planner
is not yet ready for the runtime it is shadowing.
"""
from __future__ import annotations

from enum import Enum


class IntegrationError(Exception):
    """Base for errors raised inside the integration boundary."""


class ShadowConfigError(IntegrationError):
    """The shadow runner was asked to do something P2a forbids.

    Raised eagerly (at construction / call time), never swallowed: it signals a
    programming or configuration mistake — enforcement or real spend switched on — not
    a runtime condition to observe. Letting it surface is the point.
    """


class ShadowFailureKind(str, Enum):
    """Why a shadow run did not produce a full result.

    Ordered from "a known Planner component was unavailable" to "we did not see this
    coming". The last one is the only catch-all, and it is still recorded, never
    hidden.
    """

    ESTIMATOR_UNAVAILABLE = "estimator_unavailable"
    PRICING_UNAVAILABLE = "pricing_unavailable"
    INVALID_PLAN = "invalid_plan"
    GOVERNANCE_PREVIEW_UNAVAILABLE = "governance_preview_unavailable"
    PERSISTENCE_UNAVAILABLE = "persistence_unavailable"
    UNEXPECTED_INTERNAL_ERROR = "unexpected_internal_error"
