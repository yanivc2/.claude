"""Corpus data model (v2-corpus §11).

`CandidateTask` is what a source yields (buggy + fixed + all tests, unclassified).
`CorpusTask` is the qualified, split, sanitized artifact — with the reference/raw/hidden
data marked EVALUATOR-ONLY so it never reaches the agent sandbox (§6).
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class CandidateTask(BaseModel):
    """Raw candidate from a CorpusSource — nothing qualified yet."""

    candidate_id: str
    task_family: str
    buggy_source: dict[str, str]           # {path: content}
    fixed_source: dict[str, str]           # EVALUATOR-ONLY (qualification oracle)
    test_files: dict[str, str]             # {path: content} — mixed F2P/P2P, classified by §4
    problem_statement_raw: str


class PatchSize(BaseModel):
    files: int = 0
    lines: int = 0


class Qualification(BaseModel):
    admitted: bool
    buggy_fail: bool = False               # F2P fails on buggy (expected reason)
    fixed_pass: bool = False               # F2P passes on fixed
    regression_clean: bool = False         # P2P passes on both revisions
    f2p_files: list[str] = Field(default_factory=list)   # → hidden
    p2p_files: list[str] = Field(default_factory=list)   # → public
    excluded_files: list[str] = Field(default_factory=list)
    reason: str = ""


class Contamination(BaseModel):
    # patch-similarity vs reference is a CONTAMINATION signal only, never a quality signal (§9).
    patch_similarity: Optional[float] = None


class CorpusTask(BaseModel):
    task_id: str
    task_family: str
    source: str                            # provenance, e.g. "fixture" | "pybughive"
    buggy_revision_ref: str = ""

    # Runtime source the agent edits (buggy).
    buggy_source: dict[str, str]
    # Public regression guard (P2P) — the agent sees these.
    public_tests: dict[str, str]
    # Hidden behavioural signal (F2P) — EVALUATOR-ONLY, physically withheld from the agent (§6).
    hidden_tests: dict[str, str]

    problem_statement_sanitized: str       # what the agent receives
    problem_statement_raw: str = ""        # EVALUATOR-ONLY
    sanitization_log: list[str] = Field(default_factory=list)
    reference_patch: str = ""              # EVALUATOR-ONLY

    patch_size: PatchSize = Field(default_factory=PatchSize)
    split: str = "train"                   # train | validation | holdout
    qualification: Qualification
    contamination: Contamination = Field(default_factory=Contamination)

    def agent_visible(self) -> dict:
        """Exactly the fields allowed into the agent sandbox — no hidden/reference/raw."""
        return {
            "task_id": self.task_id,
            "task_family": self.task_family,
            "source": self.buggy_source,
            "public_tests": self.public_tests,
            "problem_statement": self.problem_statement_sanitized,
        }
