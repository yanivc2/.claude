"""Experiment task schema (v2 §6, §A2).

A task is a tiny self-contained "repo": buggy source + PUBLIC tests (the agent sees
them) + HIDDEN tests (the agent never sees; the verifier uses them). ``reference_fix``
exists only so mock/fixture agents can simulate a solver — the runner never hands it
to the measured agent.
"""
from __future__ import annotations

from pydantic import BaseModel, Field

PUBLIC_DIR = "tests_public/"
HIDDEN_DIR = "tests_hidden/"


class ExperimentTask(BaseModel):
    task_id: str
    task_family: str

    source: dict[str, str]                 # {"solution.py": "<buggy>"}
    public_tests: dict[str, str]           # {"tests_public/test_x.py": "..."}
    hidden_tests: dict[str, str]           # {"tests_hidden/test_y.py": "..."}

    # Paths the agent must NOT modify (hash-checked by the verifier).
    protected_prefixes: list[str] = Field(default_factory=lambda: [PUBLIC_DIR, HIDDEN_DIR])
    max_changed_files: int = 1             # patch scope gate
    forbidden_patterns: list[str] = Field(default_factory=list)  # no-shortcut regexes
    static_targets: list[str] = Field(default_factory=list)      # source files to compile-check

    # Solver oracle — for mocks/fixtures ONLY. Never exposed to the measured agent.
    reference_fix: dict[str, str] = Field(default_factory=dict)

    def all_files(self) -> dict[str, str]:
        """Everything materialised into the sandbox (source + both test suites)."""
        return {**self.source, **self.public_tests, **self.hidden_tests}

    def source_paths(self) -> list[str]:
        return list(self.source)

    def public_test_paths(self) -> list[str]:
        return list(self.public_tests)
