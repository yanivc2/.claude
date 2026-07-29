"""Corpus + ingestion layer (Phase-1 validation v2 — corpus contract).

The most error-prone part of the experiment: a leaked reference, a git-reachable hidden
test, or a solution-leaking description silently fakes the result. This layer is a
checkable contract — source-neutral (§1), with per-task qualification (§4), an
empirical public/hidden split (§5), physical agent/evaluator isolation (§6), statement
sanitization (§7), an agent-patch guard (§8), and a signed holdout manifest (§10).

Everything here is exercised against a synthetic FixtureCorpusSource — NOT real data.
The real source (PyBugHive first) is wired behind a seam and gated on a qualification
report (§3) + reproducibility check before use.
"""
from .build import build_corpus_task
from .evaluator import evaluate_patch, to_agent_task
from .manifest import HoldoutManifest, seal_holdout, verify_holdout
from .models import CandidateTask, CorpusTask, PatchSize, Qualification
from .patch_guard import PatchGuardResult, check_patch
from .qualification import qualify_candidate
from .report import CandidateReport, build_report
from .sanitize import sanitize_statement
from .source import CorpusSource

__all__ = [
    "CorpusSource", "CandidateTask", "CorpusTask", "PatchSize", "Qualification",
    "qualify_candidate", "build_corpus_task", "sanitize_statement",
    "to_agent_task", "evaluate_patch", "check_patch", "PatchGuardResult",
    "seal_holdout", "verify_holdout", "HoldoutManifest",
    "CandidateReport", "build_report",
]
