"""Sandbox with repository reset (v2 §6).

Materialises a task's files into a fresh temp dir, tracks protected-path hashes so
tampering is detectable, and runs pytest suites. A new Sandbox per run == repository
reset between runs. The agent never touches this directly — it goes through the
path-scoped tools in agent.py.
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

from .task import ExperimentTask


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class Sandbox:
    def __init__(self, task: ExperimentTask) -> None:
        self.task = task
        self._tmp: Optional[tempfile.TemporaryDirectory] = None
        self.root: Optional[Path] = None
        self._protected_before: dict[str, str] = {}

    def __enter__(self) -> "Sandbox":
        self._tmp = tempfile.TemporaryDirectory(prefix="mo_exp_")
        self.root = Path(self._tmp.name)
        for rel, content in self.task.all_files().items():
            self._materialise(rel, content)
        self._protected_before = self._hash_protected()
        return self

    def __exit__(self, *exc) -> None:
        if self._tmp is not None:
            self._tmp.cleanup()  # repository reset
            self._tmp = None
            self.root = None

    # --- files ---
    def _materialise(self, rel: str, content: str) -> None:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def read(self, rel: str) -> str:
        return (self.root / rel).read_text()

    def write(self, rel: str, content: str) -> None:
        self._materialise(rel, content)

    def exists(self, rel: str) -> bool:
        return (self.root / rel).exists()

    # --- integrity ---
    def _hash_protected(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for rel in self.task.all_files():
            if any(rel.startswith(pref) for pref in self.task.protected_prefixes):
                out[rel] = _sha(self.read(rel))
        return out

    def protected_unchanged(self) -> bool:
        return self._hash_protected() == self._protected_before

    def changed_source_files(self) -> list[str]:
        changed = []
        for rel, original in self.task.source.items():
            if not self.exists(rel) or self.read(rel) != original:
                changed.append(rel)
        return changed

    # --- execution ---
    def run_pytest(self, subdir: str, timeout_s: int = 30) -> tuple[bool, str]:
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", subdir],
            cwd=self.root, capture_output=True, text=True, timeout=timeout_s,
        )
        out = proc.stdout.strip()
        summary = out.splitlines()[-1] if out else ""
        return proc.returncode == 0, summary
