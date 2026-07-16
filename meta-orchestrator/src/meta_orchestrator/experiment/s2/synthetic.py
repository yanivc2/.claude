"""Synthetic stand-in tasks for the OFFLINE mock harness.

The real §2 corpus is 27 PyBugHive bugs whose reproduction needs a cloned repo + real
test run — NOT offline. To exercise the harness plumbing (isolation, routing, sealing,
cross-fold hygiene) with the REAL Sandbox + REAL composite verifier and NO network / NO
model, each admitted id is mapped to a tiny self-contained task whose family is taken from
the (frozen) family map. Every task has a real public+hidden suite that fails on the bug and
passes on the reference fix, plus a forbidden-shortcut pattern — so the verifier genuinely
runs. These stand-ins are for wiring only; the real bugs replace them online, unchanged code.
"""
from __future__ import annotations

import re

from ..task import ExperimentTask


def _slug(task_id: str) -> str:
    return "fn_" + re.sub(r"\W", "_", task_id)


def synthetic_task(task_id: str, family: str) -> ExperimentTask:
    """A tiny off-by-one bug tagged with the given semantic family (real verifier applies)."""
    name = _slug(task_id)
    source = f"def {name}(n):\n    # BUG: excludes n\n    return sum(range(1, n))\n"
    fix = f"def {name}(n):\n    return sum(range(1, n + 1))\n"
    public = (f"from solution import {name}\n\n"
              f"def test_pub():\n    assert {name}(5) == 15\n")
    hidden = (f"from solution import {name}\n\n"
              f"def test_hid_a():\n    assert {name}(3) == 6\n\n"
              f"def test_hid_b():\n    assert {name}(1) == 1\n")
    return ExperimentTask(
        task_id=task_id,
        task_family=family,
        source={"solution.py": source},
        public_tests={"tests_public/test_public.py": public},
        hidden_tests={"tests_hidden/test_hidden.py": hidden},
        max_changed_files=1,
        forbidden_patterns=[r"return\s+15\b"],   # anti-hardcode: the public answer
        static_targets=["solution.py"],
        reference_fix={"solution.py": fix},
    )


def build_synthetic_corpus(family_map: dict[str, str]) -> dict[str, ExperimentTask]:
    return {tid: synthetic_task(tid, fam) for tid, fam in family_map.items()}
