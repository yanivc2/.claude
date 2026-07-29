"""PyBugHiveSource — first REAL adapter (v2-corpus §2), behind a seam.

PyBugHive is a manually-validated Python bug dataset (~149 bugs / 11 projects) with a
description + patch + tests + setup per bug. It is the pilot source, but it is NOT wired
live yet: per §3 you must first fetch it and run the qualification report + a
reproducibility pass ("reproducible now") before choosing a slice. This class fixes the
interface; the fetch/reproduce path is deliberately unimplemented so nothing runs against
un-vetted real data by accident.

To complete it:
  1. Fetch the dataset into a local cache (network; the AGENT sandbox stays offline — §6).
  2. For each bug, map to CandidateTask: buggy revision → buggy_source, fixed revision →
     fixed_source, its test suite → test_files, PR/issue text → problem_statement_raw.
     Strip .git / issue-ids from anything that will reach the agent (§6, §7).
  3. Run build_report(PyBugHiveSource()) and pick 1–2 projects from the §3 table.
Everything downstream (qualify → split → sanitize → isolate → manifest) already works
against this interface — proven via FixtureCorpusSource.
"""
from __future__ import annotations

from .models import CandidateTask


class PyBugHiveSource:
    name = "pybughive"

    def __init__(self, cache_dir: str | None = None) -> None:
        self._cache_dir = cache_dir

    def list_candidates(self) -> list[CandidateTask]:  # pragma: no cover - seam
        raise NotImplementedError(
            "PyBugHiveSource is not wired to live data yet. Fetch the dataset and map each "
            "bug to CandidateTask, then run build_report() before using it (v2-corpus §2/§3)."
        )

    def get(self, candidate_id: str) -> CandidateTask:  # pragma: no cover - seam
        raise NotImplementedError("PyBugHiveSource: implement dataset fetch/mapping first (§2/§3).")
