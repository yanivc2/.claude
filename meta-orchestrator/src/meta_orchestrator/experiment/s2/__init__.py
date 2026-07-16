"""§2 learning-experiment harness (offline, mock-only for Step 1).

Design is frozen in ``corpus/EXPERIMENT_S2_DESIGN.md`` (Decisions A–E). This package wires the
four conditions A / C / D / B1 over the 27-task corpus with the REAL Sandbox + verifier and NO
model / NO network. See ``examples/s2_offline_harness.py`` for the report runner.
"""
from .families import SEMANTIC_FAMILIES, family_map_hash, is_known_family
from .folds import Fold, FoldError, stratified_folds, train_representation_gaps, validate_folds
from .gate import GateDecision, StabilitySignals, continue_decision
from .harness import (FoldRun, Outcome, OutcomesSealedError, RealRunBlocked, S2Harness,
                      SealedOutcomes)
from .lifecycle import Learner, MockLearner, learn_bank
from .memory import (CONDITIONS, FrozenLessonBank, MemoryContext, MemoryFrozenError,
                     PlaceboRouter, StaticPlaybook, parse_mem_tag, render_lines, resolve_memory)
from .mocks import LessonSensitiveMock
from .playbook_d import (DSubmission, DValidationError, PlaybookEntry, freeze_d,
                         submission_hash, validate_d_submission)
from .synthetic import build_synthetic_corpus, synthetic_task

__all__ = [
    "SEMANTIC_FAMILIES", "family_map_hash", "is_known_family",
    "Fold", "FoldError", "stratified_folds", "train_representation_gaps", "validate_folds",
    "GateDecision", "StabilitySignals", "continue_decision",
    "FoldRun", "Outcome", "OutcomesSealedError", "RealRunBlocked", "S2Harness", "SealedOutcomes",
    "Learner", "MockLearner", "learn_bank",
    "CONDITIONS", "FrozenLessonBank", "MemoryContext", "MemoryFrozenError", "PlaceboRouter",
    "StaticPlaybook", "parse_mem_tag", "render_lines", "resolve_memory",
    "LessonSensitiveMock",
    "DSubmission", "DValidationError", "PlaybookEntry", "freeze_d", "submission_hash",
    "validate_d_submission",
    "build_synthetic_corpus", "synthetic_task",
]
