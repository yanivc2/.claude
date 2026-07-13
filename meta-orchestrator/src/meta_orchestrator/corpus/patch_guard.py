"""Agent-patch guard (v2-corpus §8).

An independent diff validator over the agent's changed paths: the agent may edit source
only. Touching tests, the verifier, setup, deps, or discovery config is rejected — and a
patch that touches ONLY tests is a test-only "fix" (auto-reject). This is defence in
depth alongside the path-scoped tools (§6).
"""
from __future__ import annotations

import re

from pydantic import BaseModel, Field

_TEST = re.compile(r"(^|/)(tests?_?\w*/|test_|conftest\.py)")
_SETUP = re.compile(r"(^|/)(setup\.py|setup\.cfg|pyproject\.toml|requirements[\w.-]*\.txt|tox\.ini|"
                    r"pytest\.ini|\.github/)")


class PatchGuardResult(BaseModel):
    ok: bool
    violations: list[str] = Field(default_factory=list)


def is_test_path(path: str) -> bool:
    return bool(_TEST.search(path))


def is_setup_path(path: str) -> bool:
    return bool(_SETUP.search(path))


def check_patch(changed_paths: list[str], allowed_source_paths: list[str]) -> PatchGuardResult:
    violations: list[str] = []
    if changed_paths and all(is_test_path(p) for p in changed_paths):
        violations.append("test-only fix (patch touches only tests)")
    for p in changed_paths:
        if is_test_path(p):
            violations.append(f"edits a test/verifier file: {p}")
        elif is_setup_path(p):
            violations.append(f"edits setup/deps/config: {p}")
        elif p not in allowed_source_paths:
            violations.append(f"outside the allowed source set: {p}")
    return PatchGuardResult(ok=not violations, violations=violations)
