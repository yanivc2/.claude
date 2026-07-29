"""Isolated pytest runner for qualification/evaluation.

Materialises a set of files into a fresh temp dir (no .git, no network assumptions)
and runs a single test file. Used to empirically classify F2P/P2P (§4) and to evaluate
patches (§6) — always in a throwaway directory (repository reset).
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path


def run_test_file(files: dict[str, str], test_path: str, timeout_s: int = 30) -> tuple[bool, str]:
    """Return (passed, summary) for ``test_path`` given the full file set."""
    with tempfile.TemporaryDirectory(prefix="mo_corp_") as tmp:
        root = Path(tmp)
        for rel, content in files.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", test_path],
            cwd=root, capture_output=True, text=True, timeout=timeout_s,
        )
    out = proc.stdout.strip()
    summary = out.splitlines()[-1] if out else ""
    # returncode 0 = passed; 5 = "no tests collected"; anything else = failed/errored
    return proc.returncode == 0, summary


def compiles(source: str, filename: str = "x.py") -> bool:
    try:
        compile(source, filename, "exec")
        return True
    except SyntaxError:
        return False
