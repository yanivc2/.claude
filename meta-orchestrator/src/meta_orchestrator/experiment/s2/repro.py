"""Repo-backed reproduction + extraction for the real §2 corpus (online, model-free).

Real Black/cookiecutter/discord.py bugs can't live in the tiny-file Sandbox: their tests need
the installed package. This module clones the real repo, checks out the buggy/fixed revisions,
extracts EXACTLY the frozen ``allowed_source_files`` (scope amendment A), builds the reference
fix from only those files, and runs an 8-point, model-free reproduction gate before a bug is
admitted as a wired task. install/timeout failures are HARNESS failures, never repair failures.

No per-bug special-casing: the driver is general. A pipeline fix must be re-run over every task,
including ones that already passed.
"""
from __future__ import annotations

import re
import subprocess
import sys
import time
from typing import Optional

from pydantic import BaseModel, Field

from ...corpus.models import CandidateTask
from ...corpus.pybughive_qual import plan_f2p_selection
from ...corpus.sanitize import sanitize_statement

# --- frozen operational envelope -------------------------------------------------------------
TIMEOUTS = {"clone": 600, "venv": 300, "pip": 600, "install": 600, "pytest": 300,
            "enrich_pytest": 120}


class ReproStatus:
    # Two "reproduced" statuses (both VALID): the public (P2P) suite is optional (decision A).
    REPRODUCED_PUBLIC_NONEMPTY = "reproduced_public_nonempty"
    REPRODUCED_PUBLIC_EMPTY = "reproduced_public_empty"
    NON_REPRODUCIBLE = "non_reproducible"
    HARNESS_DEPENDENCY_FAILURE = "harness_dependency_failure"
    INVALID_F2P = "invalid_f2p"
    INVALID_P2P = "invalid_p2p"           # reserved (unreachable): P2P=∅ is valid, never invalid
    LEAKAGE_REJECTED = "leakage_rejected"

    REPRODUCED = {REPRODUCED_PUBLIC_NONEMPTY, REPRODUCED_PUBLIC_EMPTY}  # both count as reproduced


class RepoBackedTask(BaseModel):
    """A wired, frozen real task (evaluator holds fixed_source; the agent never sees it)."""
    task_id: str
    project: str
    family: str
    repo_url: str
    buggy_rev: str
    fixed_rev: str
    allowed_source_files: list[str]
    repair_scope: str                       # single_file | multi_file
    buggy_source: dict[str, str]            # allowed files @ buggy
    reference_fix: dict[str, str]           # allowed files @ fixed (EVALUATOR-ONLY)
    f2p_plan: list[list] = Field(default_factory=list)   # hidden: [[test_file, keyword|None], ...]
    p2p_nodes: list[str] = Field(default_factory=list)   # public: node ids passing on both revs
    public_suite_empty: bool = False                     # decision A: ∅ public suite is valid
    sanitized_statement: str


class ReproReport(BaseModel):
    task_id: str
    status: str
    gates: dict[str, bool] = Field(default_factory=dict)
    detail: str = ""
    install_s: float = 0.0
    test_s: float = 0.0
    timed_out: bool = False


# --- subprocess helpers (general; no per-bug logic) -----------------------------------------
class _Res:
    def __init__(self, rc, out="", timed_out=False):
        self.returncode, self.stdout, self.timed_out = rc, out, timed_out


def _run(cmd, cwd=None, timeout=600):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return _Res(r.returncode, r.stdout + r.stderr)
    except subprocess.TimeoutExpired:
        return _Res(124, f"TIMEOUT {timeout}s", timed_out=True)


def _checkout(repo, ref, paths=None):
    if paths:
        return _run(["git", "checkout", "-q", ref, "--", *paths], cwd=repo)
    return _run(["git", "checkout", "-q", "-f", ref], cwd=repo)


def _git_show(repo, ref, path) -> Optional[str]:
    r = _run(["git", "show", f"{ref}:{path}"], cwd=repo)
    return r.stdout if r.returncode == 0 else None


def _build_tests_index(repo) -> dict[str, str]:
    import os
    idx: dict[str, str] = {}
    tdir = os.path.join(repo, "tests")
    if not os.path.isdir(tdir):
        return idx
    for base, _d, files in os.walk(tdir):
        for fn in files:
            if fn.endswith(".py"):
                full = os.path.join(base, fn)
                try:
                    idx[os.path.relpath(full, repo)] = open(full, encoding="utf-8", errors="ignore").read()
                except OSError:
                    pass
    return idx


def _run_plan(py, repo, plan):
    nodes: dict[str, str] = {}
    timed_out = False
    for test_file, keyword in plan:
        cmd = [py, "-m", "pytest", "-o", "addopts=", "-rA", "--tb=line", "-q", test_file]
        if keyword:
            cmd += ["-k", keyword]
        r = _run(cmd, cwd=repo, timeout=TIMEOUTS["pytest"])
        timed_out = timed_out or r.timed_out
        for line in r.stdout.splitlines():
            m = re.match(r"(PASSED|FAILED|ERROR)\s+(\S+)", line)
            if m:
                nodes[m.group(2)] = m.group(1)
    return nodes, timed_out


# --- statement leak scan (gate 6) -----------------------------------------------------------
def statement_leak_scan(sanitized: str, hidden_test_names: list[str], fixed_rev: str,
                        allowed_files: list[str]) -> list[str]:
    """Reject a statement that leaks a hidden-test name, the fix commit, a patch hint, or an
    allowed-file path. Runs on top of corpus/sanitize.py (which already strips file refs +
    added solution identifiers)."""
    hits: list[str] = []
    low = sanitized.lower()
    for name in hidden_test_names:
        base = name.split("::")[-1]
        if base and base.lower() in low:
            hits.append(f"hidden-test name '{base}'")
    if fixed_rev[:8].lower() in low:
        hits.append("fix commit hash")
    for path in allowed_files:
        if path.lower() in low or path.split("/")[-1].lower() in low:
            hits.append(f"allowed-file path '{path}'")
    if re.search(r"(?i)\bthe fix is\b|\broot cause\b|@@|\bdiff\b", sanitized):
        hits.append("patch hint")
    return hits


def _enrich_p2p(py, repo, plan, f2p_nodes, buggy, fixed, allowed) -> list[str]:
    """Best-effort ONLY (decision B): when the in-plan P2P is empty, try ONE unfiltered run of
    the plan's test files per revision, with a short fixed timeout, to find stable pass-on-both
    public tests. Any timeout / collection error / instability → return [] (NEVER a failure).
    General + deterministic — no per-bug tuning."""
    files = sorted({f for f, _k in plan})
    unfiltered = [[f, None] for f in files]
    to = TIMEOUTS["enrich_pytest"]
    try:
        _checkout(repo, buggy)
        # re-overlay fixed test artifacts is unnecessary here: the plan files already exist.
        if _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=TIMEOUTS["install"]).returncode != 0:
            return []
        bu, tb = _run_plan_timeout(py, repo, unfiltered, to)
        for p in allowed:
            _checkout(repo, fixed, [p])
        if _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=TIMEOUTS["install"]).returncode != 0:
            return []
        fu, tf = _run_plan_timeout(py, repo, unfiltered, to)
        if tb or tf:
            return []
        common = set(bu) & set(fu)
        return sorted(n for n in common
                      if bu[n] == "PASSED" == fu[n] and n not in set(f2p_nodes))
    except Exception:
        return []


def _run_plan_timeout(py, repo, plan, timeout):
    nodes: dict[str, str] = {}
    timed_out = False
    for test_file, keyword in plan:
        cmd = [py, "-m", "pytest", "-o", "addopts=", "-rA", "--tb=line", "-q", test_file]
        if keyword:
            cmd += ["-k", keyword]
        r = _run(cmd, cwd=repo, timeout=timeout)
        timed_out = timed_out or r.timed_out
        for line in r.stdout.splitlines():
            m = re.match(r"(PASSED|FAILED|ERROR)\s+(\S+)", line)
            if m:
                nodes[m.group(2)] = m.group(1)
    return nodes, timed_out


# --- the 8-gate reproduction driver ---------------------------------------------------------
def reproduce_bug(task_id, project, owner, issue, family, allowed_source_files,
                  repair_scope, workdir) -> tuple[Optional[RepoBackedTask], ReproReport]:
    import os
    t0 = time.time()
    rep = ReproReport(task_id=task_id, status="", gates={})
    commit = issue["commits"][0]
    fixed = commit["hash"]
    buggy = commit["parents"].split(",")[0].strip()
    rep.gates["1_deterministic_checkout"] = bool(fixed and buggy)

    repo = os.path.join(workdir, project)
    if not os.path.isdir(repo):
        c = _run(["git", "clone", "-q", f"https://github.com/{owner}/{project}", repo],
                 timeout=TIMEOUTS["clone"])
        if c.returncode != 0:
            rep.status = ReproStatus.HARNESS_DEPENDENCY_FAILURE
            rep.detail = "clone failed"
            rep.timed_out = c.timed_out
            return None, rep

    venv = os.path.join(repo, ".venv")
    if not os.path.isdir(venv):
        _run([sys.executable, "-m", "venv", venv], timeout=TIMEOUTS["venv"])
    py = os.path.join(venv, "bin", "python")
    _run([py, "-m", "pip", "install", "-q", "-U", "pip", "pytest"], timeout=TIMEOUTS["pip"])

    # gate 2: allowed_source_files must equal the reference patch's source files exactly.
    patch_src = sorted(f["filename"] for f in commit["stat"].get("files", [])
                       if not f["filename"].endswith((".md", ".rst", ".txt"))
                       and "test" not in f["filename"].lower())
    rep.gates["2_allowed_files_match_scope"] = patch_src == sorted(allowed_source_files)
    if not rep.gates["2_allowed_files_match_scope"]:
        rep.status = ReproStatus.HARNESS_DEPENDENCY_FAILURE
        rep.detail = f"scope mismatch: patch_src={patch_src} != allowed={sorted(allowed_source_files)}"
        return None, rep

    test_overlay = [t["filename"] for t in commit["stat"].get("tests", [])]

    # BUGGY state: buggy tree + fixed TEST artifacts overlaid (F2P spec).
    _checkout(repo, buggy)
    if test_overlay:
        _checkout(repo, fixed, test_overlay)
    ti = time.time()
    inst = _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=TIMEOUTS["install"])
    rep.install_s = round(time.time() - ti, 1)
    if inst.returncode != 0:
        rep.status = ReproStatus.HARNESS_DEPENDENCY_FAILURE
        rep.detail = "timeout_install" if inst.timed_out else "install_failed"
        rep.timed_out = inst.timed_out
        return None, rep

    # extract buggy_source (allowed files @ buggy) + reference_fix (allowed files @ fixed).
    buggy_source, reference_fix = {}, {}
    for path in allowed_source_files:
        b = _git_show(repo, buggy, path)
        f = _git_show(repo, fixed, path)
        if b is None or f is None:
            rep.status = ReproStatus.HARNESS_DEPENDENCY_FAILURE
            rep.detail = f"could not read {path} at buggy/fixed"
            return None, rep
        buggy_source[path], reference_fix[path] = b, f
    # gate 3: reference fix is built only from the allowed files' diff.
    rep.gates["3_reference_fix_from_allowed_only"] = any(
        buggy_source[p] != reference_fix[p] for p in allowed_source_files)

    plan, sel_log = plan_f2p_selection(test_overlay, _build_tests_index(repo))
    if not plan:
        rep.status = ReproStatus.NON_REPRODUCIBLE
        rep.detail = f"no F2P test selected ({sel_log})"
        rep.gates["4_f2p_fail_on_buggy_pass_on_fixed"] = False
        return None, rep

    tt = time.time()
    b1, to1 = _run_plan(py, repo, plan)          # buggy run 1
    b2, to2 = _run_plan(py, repo, plan)          # buggy run 2 (stability)
    for path in allowed_source_files:            # → FIXED state (allowed src only)
        _checkout(repo, fixed, [path])
    _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=TIMEOUTS["install"])
    f1, to3 = _run_plan(py, repo, plan)          # fixed run 1
    f2, to4 = _run_plan(py, repo, plan)          # fixed run 2 (stability)
    rep.test_s = round(time.time() - tt, 1)
    rep.timed_out = any((to1, to2, to3, to4))

    common = set(b1) & set(b2) & set(f1) & set(f2)
    # gate 7: clean re-run reproducibility (same verdict across the two runs of each rev).
    stable = bool(common) and all(b1[n] == b2[n] and f1[n] == f2[n] for n in common)
    rep.gates["7_clean_rerun_stable"] = stable

    f2p = [n for n in common if b1[n] == b2[n] == "FAILED" and f1[n] == f2[n] == "PASSED"]
    p2p = [n for n in common if b1[n] == b2[n] == "PASSED" == f1[n] == f2[n]]
    rep.gates["4_f2p_fail_on_buggy_pass_on_fixed"] = bool(f2p)

    if not stable:
        rep.status = ReproStatus.NON_REPRODUCIBLE
        rep.detail = "unstable verdicts across clean re-runs"
        return None, rep
    if not f2p:
        rep.status = ReproStatus.INVALID_F2P
        rep.detail = "no test fails-on-buggy AND passes-on-fixed"
        return None, rep

    # gate 5 (decision A): the public suite is OPTIONAL. If the in-plan P2P is empty, try a
    # bounded best-effort enrichment; an empty result is VALID, not a failure.
    if not p2p:
        p2p = _enrich_p2p(py, repo, plan, f2p, buggy, fixed, allowed_source_files)
    public_empty = not p2p
    rep.gates["5_public_suite_optional"] = True     # never a reject gate

    # gate 6: statement built ONLY from issue text, sanitized + leak-scanned.
    raw = (issue.get("title") or "").strip() + "\n" + (issue.get("body") or "").strip()
    cand = CandidateTask(candidate_id=task_id, task_family=family, buggy_source=buggy_source,
                         fixed_source=reference_fix, test_files={}, problem_statement_raw=raw)
    san = sanitize_statement(cand)
    leaks = statement_leak_scan(san.sanitized, [n for n in f2p], fixed, allowed_source_files)
    rep.gates["6_statement_clean"] = san.usable and not leaks
    if not rep.gates["6_statement_clean"]:
        rep.status = ReproStatus.LEAKAGE_REJECTED
        rep.detail = f"usable={san.usable} leaks={leaks}"
        return None, rep

    rep.status = (ReproStatus.REPRODUCED_PUBLIC_EMPTY if public_empty
                  else ReproStatus.REPRODUCED_PUBLIC_NONEMPTY)
    rep.detail = f"F2P={len(f2p)} P2P={len(p2p)}{' (public suite empty — valid)' if public_empty else ''} ({round(time.time()-t0,1)}s)"
    task = RepoBackedTask(
        task_id=task_id, project=project, family=family,
        repo_url=f"https://github.com/{owner}/{project}", buggy_rev=buggy, fixed_rev=fixed,
        allowed_source_files=sorted(allowed_source_files), repair_scope=repair_scope,
        buggy_source=buggy_source, reference_fix=reference_fix,
        f2p_plan=[list(p) for p in plan], p2p_nodes=sorted(p2p),
        public_suite_empty=public_empty, sanitized_statement=san.sanitized,
    )
    return task, rep
