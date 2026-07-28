"""Rules-based usage estimation (P1b) — the product replacement for ``chars // 4``.

Answers *how much usage will this plan take*. It does not price it (that is
``planner.pricing``), does not decide whether it may run, and does not read anything —
it is handed measured facts and returns token bands.

    EstimationRequest -> UsageEstimate -> [PricingSource] -> CostProjection

What the module holds to:

* **No single characters-per-token multiplier.** Each content family has its own rule,
  because Hebrew, English, code and JSON differ by roughly a factor of four.
* **Output is not derived from input size.** It comes from an explicit profile and an
  explicit cap.
* **Retries and verification are visible line items**, never a hidden multiplier.
* **Confidence is ``UNKNOWN``**, enforced by a validator. Completeness — how much input
  arrived — is a separate measure and is not a stand-in for it.
* **No fallback.** A missing rule, an unbounded retry count or an unknown profile
  raises. There is no path back to a silent default.
* Every coefficient is labelled ``HEURISTIC``; none has been compared with an actual.

G1 status: this is a tested replacement. The orchestrator is **not** wired to it, so
``chars // 4`` is still what runs — REPLACEMENT_READY, not FIXED.
"""
from __future__ import annotations

from .entities import (
    Band,
    CallGroupEstimate,
    Completeness,
    StageUsageEstimate,
    UsageEstimate,
)
from .errors import (
    CostProjectionUnavailableError,
    EstimationError,
    InconsistentEstimateError,
    MissingRuleError,
    UnboundedEstimateError,
)
from .estimator import DEFAULT_OUTPUT_PROFILES, UsageEstimator, request_hash
from .metrics import ContentFamily, ContentMetrics, RequestOverheads, ScriptHint
from .profiles import (
    ALLOWED_BASES_P1B,
    ESTIMATOR_ID,
    ESTIMATOR_VERSION,
    RULESET_VERSION,
    TOKEN_RULES,
    OutputProfile,
    RuleBasis,
    TokenRule,
    output_profile,
)
from .request import CallKind, EstimationRequest, StageInput

__all__ = [
    # request
    "EstimationRequest", "StageInput", "CallKind",
    # metrics
    "ContentMetrics", "ContentFamily", "ScriptHint", "RequestOverheads",
    # profiles
    "TokenRule", "TOKEN_RULES", "RuleBasis", "ALLOWED_BASES_P1B", "OutputProfile",
    "output_profile", "RULESET_VERSION", "ESTIMATOR_ID", "ESTIMATOR_VERSION",
    # results
    "UsageEstimate", "StageUsageEstimate", "CallGroupEstimate", "Band", "Completeness",
    # estimator
    "UsageEstimator", "DEFAULT_OUTPUT_PROFILES", "request_hash",
    # errors
    "EstimationError", "MissingRuleError", "UnboundedEstimateError",
    "InconsistentEstimateError", "CostProjectionUnavailableError",
]
