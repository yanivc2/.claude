"""Candidate qualification report (v2-corpus §3).

Don't choose a source by name — measure it first. For each candidate this runs the
qualification pipeline and records what §3 asks for. Fields that need a solver run
(baseline_success, family_similarity) are left None and flagged — they come once a real
model is wired, not from ingestion alone.
"""
from __future__ import annotations

import time

from pydantic import BaseModel, Field

from .build import CandidateRejected, build_corpus_task
from .qualification import qualify_candidate
from .sanitize import sanitize_statement
from .source import CorpusSource


class CandidateReport(BaseModel):
    candidate_id: str
    task_family: str
    reproducible_now: bool          # qualification ran without an environment error
    admitted: bool
    valid_f2p: int                  # empirically fail-on-buggy & pass-on-fixed
    clean_p2p: int
    excluded: int
    description_usable: bool        # can the bug be diagnosed from the sanitized statement?
    patch_files: int = 0
    patch_lines: int = 0
    runtime_s: float = 0.0
    reason: str = ""
    # Require a solver run — not derivable from ingestion (flagged, not faked):
    baseline_success: float | None = None
    family_similarity: float | None = None


class ReportSummary(BaseModel):
    source: str
    total_candidates: int
    admitted: int
    rows: list[CandidateReport] = Field(default_factory=list)
    note: str = ("baseline_success & family_similarity require solver runs (Pilot-1 "
                 "calibration) — not computed at ingestion time.")


def build_report(source: CorpusSource) -> ReportSummary:
    rows: list[CandidateReport] = []
    for cand in source.list_candidates():
        t0 = time.monotonic()
        reproducible, patch_files, patch_lines, reason = True, 0, 0, ""
        try:
            qual = qualify_candidate(cand)
            san = sanitize_statement(cand)
            admitted = qual.admitted and san.usable
            if admitted:
                task = build_corpus_task(cand, source_name=source.name)
                patch_files, patch_lines = task.patch_size.files, task.patch_size.lines
                reason = "admitted"
            else:
                reason = qual.reason if not qual.admitted else "statement too vague"
        except CandidateRejected as exc:
            qual = qualify_candidate(cand)
            san = sanitize_statement(cand)
            admitted, reason = False, str(exc)
        except Exception as exc:  # environment/repro failure (§3 "reproducible now")
            rows.append(CandidateReport(
                candidate_id=cand.candidate_id, task_family=cand.task_family,
                reproducible_now=False, admitted=False, valid_f2p=0, clean_p2p=0, excluded=0,
                description_usable=False, runtime_s=round(time.monotonic() - t0, 3),
                reason=f"not reproducible: {type(exc).__name__}: {exc}"))
            continue

        rows.append(CandidateReport(
            candidate_id=cand.candidate_id, task_family=cand.task_family,
            reproducible_now=reproducible, admitted=admitted,
            valid_f2p=len(qual.f2p_files), clean_p2p=len(qual.p2p_files),
            excluded=len(qual.excluded_files), description_usable=san.usable,
            patch_files=patch_files, patch_lines=patch_lines,
            runtime_s=round(time.monotonic() - t0, 3), reason=reason))

    return ReportSummary(source=source.name, total_candidates=len(rows),
                         admitted=sum(r.admitted for r in rows), rows=rows)
