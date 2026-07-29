"""Concrete verifier for the code-fix seed task (SPEC §5.4, B1).

The objective success signal is *measured*, not estimated: the candidate module is
written to a temp dir alongside the case's pytest suite and pytest is actually run.
This is the objective dimension (§5.3) — it always runs and cannot be overridden.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from ..models import FailureCategory, VerifyResult
from ..seed_task.definition import BugCase


def verify_code_fix(case: BugCase, candidate_source: str, *, timeout_s: int = 30) -> VerifyResult:
    """Run the case's pytest suite against ``candidate_source`` and report the result."""
    # 1. Cheap gate: does the candidate even compile? A syntax error is a FactualError,
    #    not a test failure (§5.6) — they update memory differently.
    try:
        compile(candidate_source, case.module_filename, "exec")
    except SyntaxError as exc:
        return VerifyResult(
            passed=False,
            confidence=1.0,
            evidence=[f"SyntaxError: {exc.msg} (line {exc.lineno})"],
            blocking=True,
            failure_category=FailureCategory.FACTUAL_ERROR,
        )

    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / case.module_filename).write_text(candidate_source)
        (d / "test_solution.py").write_text(case.test_source)
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(d)],
            cwd=d,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )

    stdout = proc.stdout.strip()
    summary = stdout.splitlines()[-1] if stdout else ""
    passed = proc.returncode == 0

    if passed:
        return VerifyResult(
            passed=True,
            confidence=1.0,
            evidence=[summary or "all tests passed"],
            blocking=True,
            failure_category=FailureCategory.NONE,
        )

    # Distinguish an import/collection error (FactualError) from an assertion failure.
    lowered = stdout.lower()
    is_import_error = "error" in lowered and ("importerror" in lowered or "no tests ran" in lowered
                                              or "errors during collection" in lowered)
    category = FailureCategory.FACTUAL_ERROR if is_import_error else FailureCategory.TESTS_FAILED
    first_fail = _first_failure_line(stdout)
    return VerifyResult(
        passed=False,
        confidence=1.0,
        evidence=[e for e in (summary, first_fail) if e],
        blocking=True,
        failure_category=category,
    )


def _first_failure_line(stdout: str) -> str:
    for line in stdout.splitlines():
        s = line.strip()
        if s.startswith("E ") or "assert" in s.lower() or s.startswith("FAILED"):
            return s
    return ""
