"""Decision / Utility Engine (SPEC §4) — one utility function owns every choice."""
from .engine import (
    BudgetExceededError,
    DecisionEngine,
    Option,
    ScoredOption,
    build_model_options,
)

__all__ = [
    "DecisionEngine",
    "Option",
    "ScoredOption",
    "BudgetExceededError",
    "build_model_options",
]
