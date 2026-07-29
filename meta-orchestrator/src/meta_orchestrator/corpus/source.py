"""Source-neutral corpus interface (v2-corpus §1).

Deliberately small — not a generic framework before one adapter works. Adapters:
FixtureCorpusSource (tests) → PyBugHiveSource (first real) → BugsInPy/GitHistory (later).
"""
from __future__ import annotations

from typing import Protocol

from .models import CandidateTask


class CorpusSource(Protocol):
    name: str

    def list_candidates(self) -> list[CandidateTask]:
        """All candidate bugs this source exposes (raw, unqualified)."""
        ...

    def get(self, candidate_id: str) -> CandidateTask:
        ...
