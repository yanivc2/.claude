"""Evaluation harness (SPEC §15, D3): run the seed task ≥N times and prove learning."""
from .harness import EvalHarness, EvalReport

__all__ = ["EvalHarness", "EvalReport"]
