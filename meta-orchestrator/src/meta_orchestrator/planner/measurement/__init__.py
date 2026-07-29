"""Measured Token Pilot (P2m) — measure only, calibrate nothing.

Compares three numbers on one frozen corpus: the legacy ``chars // 4`` heuristic, the
rules-based Planner estimate, and — when a credential is available — the real measured
token count from the provider's token-counting endpoint. Input tokens only; no
generation.

Boundaries this package holds to:

* It never changes an estimator coefficient, a rule, or a profile. A ``CalibrationProposal``
  is documentation for a human, never applied.
* It never enforces anything and never touches the orchestrator's execution.
* It is fail-closed: no credential → measurement BLOCKED, not guessed; a hard budget cap
  and call ceiling refuse before any call; a zero count for non-empty input is refused.
* It is offline by default: with no counter it produces the legacy-vs-Planner comparison
  and leaves the measured column empty.
"""
from __future__ import annotations

from .budget import DEFAULT_MAX_CALLS, DEFAULT_PILOT_CAP, PilotBudget
from .corpus import CORPUS, CORPUS_VERSION, Sample, by_family, corpus_manifest
from .counter import (
    ALLOWED_MODEL_IDS,
    PILOT_MODEL_SNAPSHOT,
    AnthropicCountTokensCounter,
    CountResult,
    TokenCounter,
)
from .entities import (
    CalibrationProposal,
    CountingMethod,
    FamilyAnalysis,
    TokenMeasurement,
    build_measurement,
)
from .errors import (
    CredentialUnavailableError,
    GenerationForbiddenError,
    MeasurementError,
    PilotBudgetExhaustedError,
    UnsupportedModelError,
    ZeroTokenMeasurementError,
)
from .pilot import PILOT_MODEL_ID, PILOT_PROVIDER, PilotRun, legacy_estimate, run_pilot

__all__ = [
    "CORPUS", "CORPUS_VERSION", "Sample", "by_family", "corpus_manifest",
    "PilotBudget", "DEFAULT_PILOT_CAP", "DEFAULT_MAX_CALLS",
    "TokenCounter", "CountResult", "AnthropicCountTokensCounter",
    "ALLOWED_MODEL_IDS", "PILOT_MODEL_SNAPSHOT",
    "TokenMeasurement", "build_measurement", "CountingMethod", "FamilyAnalysis",
    "CalibrationProposal",
    "run_pilot", "PilotRun", "legacy_estimate", "PILOT_MODEL_ID", "PILOT_PROVIDER",
    "MeasurementError", "CredentialUnavailableError", "PilotBudgetExhaustedError",
    "UnsupportedModelError", "GenerationForbiddenError", "ZeroTokenMeasurementError",
]
