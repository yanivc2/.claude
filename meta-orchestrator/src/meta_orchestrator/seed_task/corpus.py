"""A tiny seed corpus of bug cases (SPEC §3).

Each case is self-contained: buggy source, a pytest suite that fails on the bug and
passes on ``reference_fix``. Real code + real tests → a clean binary success signal.
"""
from __future__ import annotations

from .definition import BugCase

SEED_CORPUS: list[BugCase] = [
    BugCase(
        bug_id="off_by_one_sum",
        category="off_by_one",
        module_filename="solution.py",
        module_source=(
            "def sum_to(n):\n"
            "    # BUG: excludes n (range stops at n-1)\n"
            "    return sum(range(1, n))\n"
        ),
        test_source=(
            "from solution import sum_to\n\n"
            "def test_sum_to_five():\n"
            "    assert sum_to(5) == 15\n\n"
            "def test_sum_to_one():\n"
            "    assert sum_to(1) == 1\n"
        ),
        reference_fix=(
            "def sum_to(n):\n"
            "    return sum(range(1, n + 1))\n"
        ),
    ),
    BugCase(
        bug_id="wrong_operator_even",
        category="wrong_operator",
        module_filename="solution.py",
        module_source=(
            "def is_even(x):\n"
            "    # BUG: compares to 1 instead of 0\n"
            "    return x % 2 == 1\n"
        ),
        test_source=(
            "from solution import is_even\n\n"
            "def test_even():\n"
            "    assert is_even(4) is True\n\n"
            "def test_odd():\n"
            "    assert is_even(3) is False\n"
        ),
        reference_fix=(
            "def is_even(x):\n"
            "    return x % 2 == 0\n"
        ),
    ),
    BugCase(
        bug_id="wrong_return_max",
        category="wrong_return",
        module_filename="solution.py",
        module_source=(
            "def max_of(a, b):\n"
            "    # BUG: returns the smaller value\n"
            "    return a if a < b else b\n"
        ),
        test_source=(
            "from solution import max_of\n\n"
            "def test_max_first():\n"
            "    assert max_of(9, 2) == 9\n\n"
            "def test_max_second():\n"
            "    assert max_of(1, 7) == 7\n"
        ),
        reference_fix=(
            "def max_of(a, b):\n"
            "    return a if a > b else b\n"
        ),
    ),
    BugCase(
        bug_id="off_by_one_last",
        category="off_by_one",
        module_filename="solution.py",
        module_source=(
            "def last_index(xs):\n"
            "    # BUG: off by one, returns len instead of len-1\n"
            "    return len(xs)\n"
        ),
        test_source=(
            "from solution import last_index\n\n"
            "def test_last_index():\n"
            "    assert last_index([10, 20, 30]) == 2\n"
        ),
        reference_fix=(
            "def last_index(xs):\n"
            "    return len(xs) - 1\n"
        ),
    ),
]


def get_case(bug_id: str) -> BugCase:
    for c in SEED_CORPUS:
        if c.bug_id == bug_id:
            return c
    raise KeyError(bug_id)
