"""Synthetic corpus source for pipeline tests (NOT real data).

Four candidates exercise the whole ingestion contract: two admissible bugs (one with a
solution-leaking statement, to test §7), one too-vague statement (rejected by §7), and
one non-clean bug whose buggy revision fails for the wrong reason (rejected by §4).
"""
from __future__ import annotations

from .models import CandidateTask
from .source import CorpusSource

_BEHAVIOR = "tests/test_behavior.py"    # expected to be F2P → hidden
_REGRESSION = "tests/test_regression.py"  # expected to be P2P → public

_CANDIDATES = [
    CandidateTask(
        candidate_id="fx-sum-offbyone",
        task_family="small_bugfix",
        buggy_source={"solution.py": "def sum_to(n):\n    return sum(range(1, n))\n"},
        fixed_source={"solution.py": "def sum_to(n):\n    return sum(range(1, n + 1))\n"},
        test_files={
            _BEHAVIOR: "from solution import sum_to\n\ndef test_five():\n    assert sum_to(5) == 15\n",
            _REGRESSION: "from solution import sum_to\n\ndef test_zero():\n    assert sum_to(0) == 0\n",
        },
        # Leaks the fix (function name + exact change + path) — sanitizer must strip it.
        problem_statement_raw=(
            "sum_to(n) should return the sum of 1..n inclusive but is off by one. "
            "The fix is to change range(1, n) to range(1, n + 1) in solution.py."
        ),
    ),
    CandidateTask(
        candidate_id="fx-even-operator",
        task_family="small_bugfix",
        buggy_source={"solution.py": "def is_even(x):\n    return x % 2 == 1\n"},
        fixed_source={"solution.py": "def is_even(x):\n    return x % 2 == 0\n"},
        test_files={
            _BEHAVIOR: "from solution import is_even\n\ndef test_even():\n    assert is_even(4) is True\n",
            _REGRESSION: "from solution import is_even\n\n"
                         "def test_bool():\n    assert isinstance(is_even(4), bool)\n",
        },
        problem_statement_raw=(
            "is_even reports the wrong parity for even inputs; it should be true for even numbers."
        ),
    ),
    CandidateTask(
        candidate_id="fx-vague",
        task_family="small_bugfix",
        buggy_source={"solution.py": "def last_index(xs):\n    return len(xs)\n"},
        fixed_source={"solution.py": "def last_index(xs):\n    return len(xs) - 1\n"},
        test_files={
            _BEHAVIOR: "from solution import last_index\n\n"
                       "def test_last():\n    assert last_index([1, 2, 3]) == 2\n",
            _REGRESSION: "from solution import last_index\n\n"
                         "def test_type():\n    assert isinstance(last_index([1]), int)\n",
        },
        problem_statement_raw="fix edge case",   # too vague — rejected by §7
    ),
    CandidateTask(
        candidate_id="fx-broken",
        task_family="small_bugfix",
        buggy_source={"solution.py": "def f(:\n    return 1\n"},   # syntax error, not a clean bug
        fixed_source={"solution.py": "def f():\n    return 1\n"},
        test_files={
            _BEHAVIOR: "from solution import f\n\ndef test_f():\n    assert f() == 1\n",
            _REGRESSION: "def test_true():\n    assert True\n",
        },
        problem_statement_raw="f raises a SyntaxError and cannot be imported.",
    ),
]


class FixtureCorpusSource:
    name = "fixture"

    def list_candidates(self) -> list[CandidateTask]:
        return list(_CANDIDATES)

    def get(self, candidate_id: str) -> CandidateTask:
        for c in _CANDIDATES:
            if c.candidate_id == candidate_id:
                return c
        raise KeyError(candidate_id)


# static type check: FixtureCorpusSource satisfies CorpusSource
_src: CorpusSource = FixtureCorpusSource()
