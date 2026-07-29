"""Assemble a qualified CorpusTask from a raw candidate (v2-corpus §4→§5→§7→§11).

Pipeline: qualify (§4) → split F2P/P2P into hidden/public (§5) → sanitize the statement
(§7) → compute reference patch + size → build the CorpusTask (§11). Any gate failure
raises CandidateRejected with a reason (the report collects these).
"""
from __future__ import annotations

import difflib
import os

from ..experiment.task import HIDDEN_DIR, PUBLIC_DIR
from .models import CandidateTask, CorpusTask, PatchSize
from .qualification import qualify_candidate
from .sanitize import sanitize_statement


class CandidateRejected(ValueError):
    """A candidate did not pass an ingestion gate; not admitted to the corpus."""


def _reference_patch(candidate: CandidateTask) -> tuple[str, PatchSize]:
    chunks, files, lines = [], 0, 0
    for path, buggy in candidate.buggy_source.items():
        fixed = candidate.fixed_source.get(path, buggy)
        if fixed == buggy:
            continue
        files += 1
        diff = list(difflib.unified_diff(buggy.splitlines(True), fixed.splitlines(True),
                                         fromfile=f"a/{path}", tofile=f"b/{path}"))
        lines += sum(1 for d in diff if d.startswith(("+", "-")) and not d.startswith(("+++", "---")))
        chunks.append("".join(diff))
    return "\n".join(chunks), PatchSize(files=files, lines=lines)


def _remap(originals: dict[str, str], selected: list[str], target_dir: str) -> dict[str, str]:
    out = {}
    for path in selected:
        out[target_dir + os.path.basename(path)] = originals[path]
    return out


def build_corpus_task(candidate: CandidateTask, split: str = "train",
                      source_name: str = "fixture") -> CorpusTask:
    qual = qualify_candidate(candidate)
    if not qual.admitted:
        raise CandidateRejected(f"{candidate.candidate_id}: {qual.reason}")

    san = sanitize_statement(candidate)
    if not san.usable:
        raise CandidateRejected(f"{candidate.candidate_id}: statement too vague after sanitization")

    public_tests = _remap(candidate.test_files, qual.p2p_files, PUBLIC_DIR)
    hidden_tests = _remap(candidate.test_files, qual.f2p_files, HIDDEN_DIR)
    ref_patch, size = _reference_patch(candidate)

    return CorpusTask(
        task_id=candidate.candidate_id,
        task_family=candidate.task_family,
        source=source_name,
        buggy_source=dict(candidate.buggy_source),
        public_tests=public_tests,
        hidden_tests=hidden_tests,
        problem_statement_sanitized=san.sanitized,
        problem_statement_raw=candidate.problem_statement_raw,
        sanitization_log=san.log,
        reference_patch=ref_patch,
        patch_size=size,
        split=split,
        qualification=qual,
    )
