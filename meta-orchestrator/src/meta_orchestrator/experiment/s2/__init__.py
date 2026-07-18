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
                     OccupancyParity, PlaceboRouter, StaticPlaybook, occupancy_parity,
                     parse_mem_tag, render_lines, resolve_memory)
from .mocks import LessonSensitiveMock
from .contract_s2 import (RunPolicy, anthropic_request_kwargs, frozen_s2_contract, s2_run_policy,
                          S2_EXACT_MODEL_ID, S2_MAX_TOKENS, S2_THINKING_BUDGET_TOKENS)
from .playbook_d import (DSubmission, DValidationError, PlaybookEntry, freeze_d,
                         submission_hash, validate_d_submission)
from .solver import (AttemptContract, AttemptContractViolation, AttemptResult, FixOnRoundSolver,
                     InvalidPatchSolver, LeakingLessonSolver, MemoryIgnoringRoundSolver,
                     MemorySensitiveRoundSolver, RoundOutput, RoundView, SolverHarness,
                     SolverOutcomes, SolverOutcomesSealedError, run_attempt)
from .model_client import ModelUnavailableError, S2ModelClient, S2ModelResponse
from .synthetic import build_synthetic_corpus, synthetic_task
from .write_gate import (FoldLeakageError, HeldOutWriteError, MAX_ACTIVE_ENTRIES_PER_FAMILY,
                        WriteGateResult, assert_bank_within_train, bank_provenance,
                        evaluate_write_gate, learn_gated_bank, reference_patch_tokens)

__all__ = [
    "SEMANTIC_FAMILIES", "family_map_hash", "is_known_family",
    "Fold", "FoldError", "stratified_folds", "train_representation_gaps", "validate_folds",
    "GateDecision", "StabilitySignals", "continue_decision",
    "FoldRun", "Outcome", "OutcomesSealedError", "RealRunBlocked", "S2Harness", "SealedOutcomes",
    "Learner", "MockLearner", "learn_bank",
    "CONDITIONS", "FrozenLessonBank", "MemoryContext", "MemoryFrozenError", "OccupancyParity",
    "PlaceboRouter", "StaticPlaybook", "occupancy_parity", "parse_mem_tag", "render_lines",
    "resolve_memory",
    "LessonSensitiveMock",
    "RunPolicy", "anthropic_request_kwargs", "frozen_s2_contract", "s2_run_policy",
    "S2_EXACT_MODEL_ID", "S2_MAX_TOKENS", "S2_THINKING_BUDGET_TOKENS",
    "DSubmission", "DValidationError", "PlaybookEntry", "freeze_d", "submission_hash",
    "validate_d_submission",
    "AttemptContract", "AttemptContractViolation", "AttemptResult", "FixOnRoundSolver",
    "InvalidPatchSolver", "LeakingLessonSolver", "MemoryIgnoringRoundSolver",
    "MemorySensitiveRoundSolver", "RoundOutput", "RoundView",
    "SolverHarness", "SolverOutcomes", "SolverOutcomesSealedError", "run_attempt",
    "ModelUnavailableError", "S2ModelClient", "S2ModelResponse",
    "FoldLeakageError", "HeldOutWriteError", "MAX_ACTIVE_ENTRIES_PER_FAMILY", "WriteGateResult",
    "assert_bank_within_train", "bank_provenance", "evaluate_write_gate", "learn_gated_bank",
    "reference_patch_tokens",
    "build_synthetic_corpus", "synthetic_task",
]
