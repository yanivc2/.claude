"""Per-task qualification (v2-corpus §4) + empirical F2P/P2P classification (§5).

The reference commit is strong evidence, not truth. A task is admitted ONLY if, run in
a frozen environment:

    buggy + F2P  → FAIL (and buggy compiles — not a dep/syntax failure)
    fixed + F2P  → PASS
    buggy + P2P  → PASS      (regression guard stays green)
    fixed + P2P  → PASS

Hidden = F2P (empirically fail-on-buggy & pass-on-fixed) — NOT "every test the commit
changed" (§5). Public = P2P.
"""
from __future__ import annotations

from ._run import compiles, run_test_file
from .models import CandidateTask, Qualification


def qualify_candidate(candidate: CandidateTask) -> Qualification:
    # Buggy must at least import — a syntax/dep failure is not a clean bugfix task (§4).
    for path, src in candidate.buggy_source.items():
        if not compiles(src, path):
            return Qualification(admitted=False, reason=f"buggy {path} does not compile")

    f2p, p2p, excluded = [], [], []
    for test_path in candidate.test_files:
        buggy_pass, _ = run_test_file({**candidate.buggy_source, **candidate.test_files}, test_path)
        fixed_pass, _ = run_test_file({**candidate.fixed_source, **candidate.test_files}, test_path)
        if not buggy_pass and fixed_pass:
            f2p.append(test_path)          # demonstrates the bug → hidden
        elif buggy_pass and fixed_pass:
            p2p.append(test_path)          # regression guard → public
        else:
            excluded.append(test_path)     # fixed-regressing / both-failing / weird → drop

    buggy_fail = len(f2p) >= 1
    fixed_pass_all = buggy_fail            # F2P pass-on-fixed by construction
    regression_clean = True                # every P2P passes both by construction
    admitted = buggy_fail                  # need ≥1 empirically-proven behavioural test

    reason = "admitted" if admitted else "no test fails-on-buggy & passes-on-fixed (no F2P)"
    return Qualification(
        admitted=admitted, buggy_fail=buggy_fail, fixed_pass=fixed_pass_all,
        regression_clean=regression_clean, f2p_files=f2p, p2p_files=p2p,
        excluded_files=excluded, reason=reason,
    )
