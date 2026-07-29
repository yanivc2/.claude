"""Configuration (SPEC §16.4, §6): model choice is read from config and resolved
through the Registry — never hardcoded in orchestration logic.

Phase 1 chosen backend/adapters (confirmed with the user, see SPEC appendix):
SQLite persistence + a deterministic mock model adapter by default. Selecting the
"anthropic" adapter (via env/config) seeds real Claude models into the Registry and
routes candidate selection to them — see gateway/adapters.py. Model *ids* and prices
here come from the claude-api reference (Opus 4.8 $5/$25, Haiku 4.5 $1/$5 per 1M).
"""
from __future__ import annotations

import os
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from .models import EvalScore, ModelSpec
from .taxonomy import SEED_TASK_TYPE
from .utils import today_iso


class OrchestratorConfig(BaseModel):
    """Runtime configuration. Model *ids* referenced here MUST exist in the Registry."""

    model_config = ConfigDict(protected_namespaces=())

    db_path: str = ":memory:"

    # Candidate model ids per task type (Decision Engine picks among these — SPEC §4).
    # Names live here as config + in the Registry, NOT baked into code paths.
    candidate_models: dict[str, list[str]] = Field(
        default_factory=lambda: {SEED_TASK_TYPE: ["mock-strong", "mock-weak"]}
    )

    # Decision Engine v1 weights (SPEC §4; used from Milestone B6).
    decision_weights: dict[str, float] = Field(
        default_factory=lambda: {"w_success": 1.0, "w_cost": 0.15, "w_risk": 0.30}
    )

    # Autonomy + budget (SPEC §10; enforced from Milestone D).
    autonomy_mode: str = "full-auto"  # full-auto | ask-on-expensive | plan-first
    budget_tokens: int = 100_000
    max_rounds: int = 6

    # Which model gateway adapter to use ("mock" offline default; "anthropic" via env).
    model_adapter: str = "mock"

    # Controlled-experiment lock (v2 §5). When enabled, dynamic model selection
    # (bandit / Decision Engine) and *silent* provider fallback are BOTH disabled:
    # the run uses exactly `experiment_model_id`, and if that model is unavailable or
    # its call fails, the run FAILS LOUDLY — no fallback to another model, which would
    # be an undetectable confound. Each run records whether this mode was active.
    experiment_mode: bool = False
    experiment_model_id: Optional[str] = None


# Candidate model ids per adapter (SPEC §6: names resolved via config + Registry).
def default_candidate_models(adapter: str) -> dict[str, list[str]]:
    if adapter == "anthropic":
        return {SEED_TASK_TYPE: ["claude-opus-4-8", "claude-haiku-4-5"]}
    return {SEED_TASK_TYPE: ["mock-strong", "mock-weak"]}


def seed_registry_models(adapter: str = "mock") -> list[ModelSpec]:
    """Registry seed data (SPEC §9), WITH provenance on eval scores, per adapter."""
    if adapter == "anthropic":
        return _seed_real_models()
    return _seed_mock_models()


def _seed_real_models() -> list[ModelSpec]:
    # Real Claude models. Prices are per-1k tokens = (per-1M price / 1000), from the
    # claude-api model table. Priors are conservative seeds, corrected by verified runs.
    date = today_iso()
    return [
        ModelSpec(
            model_id="claude-opus-4-8",
            # Opus 4.8 has no dated snapshot in the official catalog — the alias IS the
            # provider id (verified against the claude-api model catalog, 2026-07-15).
            provider_model_snapshot="claude-opus-4-8",
            provider="anthropic",
            capabilities=["code", "debug", "reasoning"],
            price_per_1k_in=0.005,
            price_per_1k_out=0.025,
            latency_ms=6000,
            context_limit=1_000_000,
            tool_support=True,
            availability=True,
            fallback_model="claude-haiku-4-5",
            last_verified=date,
            eval_scores=[
                EvalScore(task_type=SEED_TASK_TYPE, score=0.85, n_samples=0, date=date, source="seed:prior")
            ],
        ),
        ModelSpec(
            model_id="claude-haiku-4-5",
            # Full dated snapshot from the official catalog (verified 2026-07-15), so the
            # frozen experiment pins an exact model build rather than a moving alias.
            provider_model_snapshot="claude-haiku-4-5-20251001",
            provider="anthropic",
            capabilities=["code"],
            price_per_1k_in=0.001,
            price_per_1k_out=0.005,
            latency_ms=2000,
            context_limit=200_000,
            tool_support=True,
            availability=True,
            fallback_model=None,
            last_verified=date,
            eval_scores=[
                EvalScore(task_type=SEED_TASK_TYPE, score=0.60, n_samples=0, date=date, source="seed:prior")
            ],
        ),
    ]


def _seed_mock_models() -> list[ModelSpec]:
    date = today_iso()
    return [
        ModelSpec(
            model_id="mock-strong",
            provider="mock",
            capabilities=["code", "debug"],
            price_per_1k_in=0.003,
            price_per_1k_out=0.015,
            latency_ms=800,
            context_limit=200_000,
            tool_support=True,
            availability=True,
            fallback_model="mock-weak",
            last_verified=date,
            eval_scores=[
                EvalScore(task_type=SEED_TASK_TYPE, score=0.80, n_samples=0, date=date, source="seed:prior")
            ],
        ),
        ModelSpec(
            model_id="mock-weak",
            provider="mock",
            capabilities=["code"],
            price_per_1k_in=0.0005,
            price_per_1k_out=0.0015,
            latency_ms=400,
            context_limit=32_000,
            tool_support=False,
            availability=True,
            fallback_model=None,
            last_verified=date,
            eval_scores=[
                EvalScore(task_type=SEED_TASK_TYPE, score=0.45, n_samples=0, date=date, source="seed:prior")
            ],
        ),
    ]


def load_config(db_path: Optional[str] = None, adapter: Optional[str] = None) -> OrchestratorConfig:
    """Load config with env overrides (SPEC §16.4).

    ``adapter`` (or env ``META_ORCH_ADAPTER``) selects mock vs anthropic; the candidate
    model list is then derived to match, so callers never hardcode model names.
    """
    cfg = OrchestratorConfig()
    if db_path is not None:
        cfg.db_path = db_path
    elif os.getenv("META_ORCH_DB"):
        cfg.db_path = os.environ["META_ORCH_DB"]
    if adapter is not None:
        cfg.model_adapter = adapter
    elif os.getenv("META_ORCH_ADAPTER"):
        cfg.model_adapter = os.environ["META_ORCH_ADAPTER"]
    if os.getenv("META_ORCH_AUTONOMY"):
        cfg.autonomy_mode = os.environ["META_ORCH_AUTONOMY"]
    if os.getenv("META_ORCH_BUDGET"):
        cfg.budget_tokens = int(os.environ["META_ORCH_BUDGET"])
    if os.getenv("META_ORCH_EXPERIMENT_MODE") in {"1", "true", "True"}:
        cfg.experiment_mode = True
    if os.getenv("META_ORCH_EXPERIMENT_MODEL"):
        cfg.experiment_model_id = os.environ["META_ORCH_EXPERIMENT_MODEL"]
    # Derive candidates to match the adapter (mock ids vs real Claude ids).
    cfg.candidate_models = default_candidate_models(cfg.model_adapter)
    return cfg
