"""$0 pre-registered audit of the path-aware leak screen (§2 write-gate leak rule v2).

Offline / no model call. The leak screen must reject real filesystem paths while ALLOWING ordinary
technical prose that merely contains a slash (parser/tokenizer, stdout/stderr). This freezes the
ruling: MUST-PASS, MUST-REJECT, and the documented BOUNDARY decisions. Exits non-zero on any
disagreement. The same fixtures are asserted by tests/test_s2_leak_screen.py.

Usage: python examples/s2_leak_screen_audit.py
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "src"))

from meta_orchestrator.experiment.lesson import _find_path_leak  # noqa: E402

# Natural-language technical phrasing — a lone slash-joined word pair is NOT a path.
MUST_PASS = ["parser/tokenizer", "stdout/stderr", "input/output", "producer/consumer",
             "read/write", "and/or", "module/function", "either/or", "client/server"]

# Genuine filesystem paths — always a leak of where the fix lives.
MUST_REJECT = ["src/black/linegen.py", "tests/test_black.py", "../tokenize.py",
               "/home/user/project/file.py", r"C:\repo\black\driver.py", "blib2to3/pgen2/tokenize"]

# Frozen boundary rulings (decided BEFORE any next paid call, task-agnostic):
#   single slash between two bare identifiers  -> PASS  (natural language)
#   >= 2 separators forming a path-like chain  -> REJECT (path-like structure)
BOUNDARY = {"black/tokenizer": "PASS", "module/function": "PASS", "foo/bar/baz": "REJECT"}


def main() -> None:
    failures: list[str] = []
    for s in MUST_PASS:
        if _find_path_leak(s) is not None:
            failures.append(f"MUST-PASS flagged as path: {s!r} -> {_find_path_leak(s)}")
    for s in MUST_REJECT:
        if _find_path_leak(s) is None:
            failures.append(f"MUST-REJECT not detected: {s!r}")
    for s, expect in BOUNDARY.items():
        got = "REJECT" if _find_path_leak(s) else "PASS"
        if got != expect:
            failures.append(f"BOUNDARY {s!r}: expected {expect}, got {got}")

    for s in MUST_PASS:
        print(f"  PASS   {s!r:22} -> {_find_path_leak(s)}")
    for s in MUST_REJECT:
        print(f"  REJECT {s!r:30} -> {_find_path_leak(s)}")
    for s, expect in BOUNDARY.items():
        print(f"  BOUND  {s!r:20} expect={expect} got={'REJECT' if _find_path_leak(s) else 'PASS'}")
    print("-" * 78)
    if failures:
        for f in failures:
            print("  FAIL:", f)
        raise SystemExit(f"LEAK-SCREEN AUDIT FAILED — {len(failures)} disagreement(s)")
    print(f"LEAK-SCREEN AUDIT PASSED — {len(MUST_PASS)} pass / {len(MUST_REJECT)} reject / "
          f"{len(BOUNDARY)} boundary, all as frozen.")


if __name__ == "__main__":
    main()
