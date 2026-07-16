"""Free (model-free) PyBugHive qualification for one project slice (v2-corpus §3/§4).

Clones each bug's real project, installs it, and measures OBJECTIVE reproducibility +
descriptors — no model calls, so $0 API cost. Emits per-candidate metadata for admitted
AND rejected, with separate fingerprint distributions.

Stop Condition (frozen): a fixed, small slice (one project, capped) — NO auto-expansion to
other projects. Each check runs TWICE on the same revision; inconsistent = flaky = rejected.

Run:  python examples/pybughive_qualify.py [project] [max_bugs]
      (defaults: cookiecutter, 15)  — writes report JSON next to stdout.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time

from meta_orchestrator.corpus.pybughive_qual import (
    CandidateMeta,
    build_report,
    fingerprint,
    is_degenerate,
    patch_metrics,
    plan_f2p_selection,
    recommend,
)

PYBUGHIVE_REPO = "https://github.com/pybughive/pybughive"
_EXC_LINE = re.compile(r"\b([A-Z][A-Za-z]*(?:Error|Exception))\b")


class _Res:
    def __init__(self, rc: int, out: str = "", timed_out: bool = False):
        self.returncode, self.stdout, self.stderr, self.timed_out = rc, out, "", timed_out


def _run(cmd: list[str], cwd: str | None = None, env: dict | None = None, timeout: int = 600):
    """Run a subprocess; a timeout is recorded and returned (never crashes the loop)."""
    try:
        r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
        return _Res(r.returncode, r.stdout + r.stderr)
    except subprocess.TimeoutExpired:
        return _Res(124, f"TIMEOUT after {timeout}s: {' '.join(cmd[:3])}", timed_out=True)


def _run_plan(py: str, cwd: str, plan: list[tuple[str, str | None]]) -> tuple[dict[str, str], str, bool]:
    """Run an F2P plan (each entry: a test file, optionally filtered by -k keyword).

    Returns merged {nodeid: PASSED|FAILED|ERROR}, concatenated output, timed_out.
    """
    nodes: dict[str, str] = {}
    out: list[str] = []
    timed_out = False
    for test_file, keyword in plan:
        cmd = [py, "-m", "pytest", "-o", "addopts=", "-rA", "--tb=line", "-q", test_file]
        if keyword:
            cmd += ["-k", keyword]
        r = _run(cmd, cwd=cwd, timeout=300)
        timed_out = timed_out or r.timed_out
        out.append(r.stdout)
        for line in r.stdout.splitlines():
            m = re.match(r"(PASSED|FAILED|ERROR)\s+(\S+)", line)
            if m:
                nodes[m.group(2)] = m.group(1)
    return nodes, "\n".join(out), timed_out


def _build_tests_index(repo: str) -> dict[str, str]:
    """Map every repo-relative test `.py` path under tests/ to its text (fixed tests overlaid)."""
    idx: dict[str, str] = {}
    tdir = os.path.join(repo, "tests")
    if not os.path.isdir(tdir):
        return idx
    for base, _dirs, files in os.walk(tdir):
        for fn in files:
            if fn.endswith(".py"):
                full = os.path.join(base, fn)
                try:
                    idx[os.path.relpath(full, repo)] = open(full, encoding="utf-8", errors="ignore").read()
                except OSError:
                    pass
    return idx


def _checkout(repo: str, ref: str, paths: list[str] | None = None) -> None:
    if paths:
        _run(["git", "checkout", "-q", ref, "--", *paths], cwd=repo)
    else:
        _run(["git", "checkout", "-q", "-f", ref], cwd=repo)


def qualify_bug(project: str, issue: dict, workdir: str, owner: str) -> CandidateMeta:
    commit = issue["commits"][0]
    fixed = commit["hash"]
    buggy = commit["parents"].split(",")[0].strip()   # fix's parent = buggy revision
    files = commit["stat"].get("files", [])
    src_files = [f for f in files if not f["filename"].endswith((".md", ".rst", ".txt"))
                 and "test" not in f["filename"].lower()]
    src_paths = [f["filename"] for f in src_files]
    # Overlay ALL fix test artifacts (data fixtures included) so the F2P selector can map a
    # fixture to the parametrized test that consumes it (see F2P_DETECTION_SPEC.md).
    test_overlay = [t["filename"] for t in commit["stat"].get("tests", [])]
    patch_text = "\n".join(f.get("patch", "") for f in src_files)
    m = patch_metrics(src_files)
    meta = CandidateMeta(
        candidate_id=f"{project}-{issue['id']}", project=project, issue=issue["id"],
        patch=m, degenerate=is_degenerate(m),
    )
    if not src_paths or not test_overlay:
        meta.installed, meta.reject_reason = False, "no_src_or_test_in_patch"
        meta.fingerprint = fingerprint("", patch_text, src_paths)
        return meta

    t0 = time.time()
    repo = os.path.join(workdir, project)
    if not os.path.isdir(repo):
        # GitHub slug comes from the dataset (owner/repo) — no hardcoded project list.
        _run(["git", "clone", "-q", f"https://github.com/{owner}/{project}", repo], timeout=600)
    venv = os.path.join(repo, ".venv")
    if not os.path.isdir(venv):
        _run([sys.executable, "-m", "venv", venv], timeout=300)
    py = os.path.join(venv, "bin", "python")
    _run([py, "-m", "pip", "install", "-q", "-U", "pip", "pytest"], timeout=600)

    # BUGGY state: buggy src (parent) + ALL fixed test artifacts overlaid (fixtures incl.).
    _checkout(repo, buggy)
    _checkout(repo, fixed, test_overlay)
    ti = time.time()
    inst = _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=600)
    meta.install_s = round(time.time() - ti, 1)
    meta.installed = inst.returncode == 0
    meta.timed_out = meta.timed_out or inst.timed_out
    if not meta.installed:
        meta.runtime_s = round(time.time() - t0, 1)
        meta.reject_reason = "timeout_install" if inst.timed_out else "install_failed"
        meta.fingerprint = fingerprint("", patch_text, src_paths)
        return meta

    # F2P test selection (frozen spec): fix's data fixtures → the parametrized tests that
    # consume them, not just the files the fix touched. Built on the buggy tree with fixed
    # tests overlaid (so newly-added fixtures/tests are visible to the index).
    plan, sel_log = plan_f2p_selection(test_overlay, _build_tests_index(repo))
    meta.f2p_selection = [f"{f}{(' -k ' + k) if k else ''}" for f, k in plan] or sel_log
    if not plan:                                            # no relevant test → harness gap
        meta.reproducible = False
        meta.stable = None
        meta.collected_any = False
        meta.nonrepro_class = "likely_harness_gap"
        meta.fingerprint = fingerprint("", patch_text, src_paths)
        meta.runtime_s = round(time.time() - t0, 1)
        return meta

    tt = time.time()
    buggy1, out_b1, to1 = _run_plan(py, repo, plan)
    buggy2, _, to2 = _run_plan(py, repo, plan)
    _checkout(repo, fixed, src_paths)                       # FIXED state: overlay fixed src too.
    _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=600)
    fixed1, _, to3 = _run_plan(py, repo, plan)
    fixed2, _, to4 = _run_plan(py, repo, plan)
    meta.test_s = round(time.time() - tt, 1)
    meta.n_test_runs = 4
    meta.timed_out = meta.timed_out or any((to1, to2, to3, to4))

    # Stability: same verdict across the two runs of each revision.
    common = set(buggy1) & set(buggy2) & set(fixed1) & set(fixed2)
    stable = bool(common) and all(buggy1[n] == buggy2[n] and fixed1[n] == fixed2[n] for n in common)
    f2p = [n for n in common
           if buggy1[n] == buggy2[n] == "FAILED" and fixed1[n] == fixed2[n] == "PASSED"]
    p2p = [n for n in common if buggy1[n] == buggy2[n] == "PASSED" == fixed1[n] == fixed2[n]]

    meta.stable = stable
    meta.f2p_fail_on_buggy = len(f2p) > 0
    meta.f2p_pass_on_fixed = len(f2p) > 0
    meta.p2p_clean_on_buggy = len(p2p) > 0
    meta.reproducible = bool(f2p) and stable
    meta.collected_any = bool(common)
    meta.error_nodes_buggy = sum(1 for s in buggy1.values() if s == "ERROR")
    # 3-way non-reproduction certainty (never claim "non-reproducible" over a harness gap):
    if not meta.reproducible and stable:
        if not common:
            meta.nonrepro_class = "likely_harness_gap"          # nothing collected → overlay/import
        elif meta.error_nodes_buggy >= max(1, len(buggy1) // 2):
            meta.nonrepro_class = "likely_harness_gap"          # majority ERROR → fixture/dep gap
        elif not f2p and buggy1 and all(v == "PASSED" for v in buggy1.values()):
            meta.nonrepro_class = "confirmed_non_reproducible"  # tests ran clean, bug not exposed
        else:
            meta.nonrepro_class = "not_reproduced_under_current_harness"
    meta.fingerprint = fingerprint(out_b1 if f2p else "", patch_text, src_paths)
    meta.runtime_s = round(time.time() - t0, 1)
    return meta


def _print_project(name, metas):
    report = build_report(name, metas)
    print(f"\n--- {name}: candidates={report.total} reproducible={report.reproducible} "
          f"admitted={report.admitted} (yield {report.admitted}/{report.total}) "
          f"high-learning-value={report.high_learning_value} ---")
    for m in metas:
        p = m.patch
        pm = f"patch={p.files}f/{p.changed_lines}l/{p.hunks}h" if p else "patch=?"
        tag = "ADMIT" + ("*HLV" if m.high_learning_value else "") if m.admitted else "reject:" + m.reject_reason
        print(f"  {m.candidate_id:22s} inst={m.installed!s:5s} repro={m.reproducible!s:5s} "
              f"stable={m.stable!s:5s} fp={m.fingerprint or '-':11s} {pm} deg={m.degenerate!s:5s} "
              f"inst_s={m.install_s} test_s={m.test_s} runs={m.n_test_runs} "
              f"{'TIMEOUT ' if m.timed_out else ''}{tag}")
    print(f"  reject reasons: {report.reject_reasons}")
    return report


def _nonrepro_breakdown(metas):
    from collections import Counter
    return dict(Counter(m.nonrepro_class for m in metas if m.nonrepro_class))


def main() -> None:
    # Post-F2P-fix re-run of the EXACT pre-fix candidate set (small-slice 4 projects from
    # pybughive_small.json + black from current.json), all fresh under the new detector — so
    # pre/post are comparable and regressions on already-admitted bugs are visible.
    work = tempfile.mkdtemp(prefix="pbh_qual_")
    meta_repo = os.path.join(work, "_pybughive")
    _run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, meta_repo], timeout=300)
    small = json.load(open(os.path.join(meta_repo, "dataset", "pybughive_small.json")))
    current = json.load(open(os.path.join(meta_repo, "dataset", "pybughive_current.json")))

    run_projects = list(small)  # cookiecutter, scrapy, discord.py, poetry (small.json bug sets)
    run_projects.append(next(p for p in current if p["repository"] == "black"))  # + black (38)

    print("=== QUALIFIER INFRASTRUCTURE ===")
    print("  pure helpers unit-tested offline (`pytest tests/test_pybughive_qual.py`).")
    print("  this run: model-free, $0 API. POST F2P-detector-fix (spec: corpus/F2P_DETECTION_SPEC.md).")
    print("  harness interventions (bug-specific): NONE — the fix is a GENERAL fixture->consumer "
          "selector; no per-bug exceptions.\n")
    print("=== CORPUS QUALIFICATION RESULTS (real bugs, post-fix) ===")

    metas = []
    for proj in run_projects:
        project = proj["repository"]
        rows = []
        for iss in proj["issues"]:
            try:
                rows.append(qualify_bug(project, iss, work, proj["username"]))
            except Exception as exc:  # a single bug's crash never kills the run
                rows.append(CandidateMeta(candidate_id=f"{project}-{iss['id']}", project=project,
                                          issue=iss["id"], reject_reason=f"error:{type(exc).__name__}"))
                print(f"  {project}-{iss['id']}: ERROR {type(exc).__name__}: {exc}")
        _print_project(project, rows)
        metas.extend(rows)

    total = build_report("post_f2p_fix", metas)
    verdict, why = recommend(total)
    print("\n" + "=" * 70)
    print("=== UNIFIED §3 REPORT (post F2P-fix; small-slice + black) ===")
    print(f"  candidates          : {total.total}")
    print(f"  reproducible        : {total.reproducible}")
    print(f"  admitted            : {total.admitted}   yield={total.admitted}/{total.total}")
    print(f"  high-learning-value : {total.high_learning_value}  (descriptive tier, NOT a gate)")
    print(f"  fingerprints ADMITTED: {total.fingerprints_admitted}")
    print(f"  fingerprints REJECTED: {total.fingerprints_rejected}")
    print(f"  rejection reasons    : {total.reject_reasons}")
    print(f"  non-repro breakdown  : {_nonrepro_breakdown(metas)}")
    print(f"  harness interventions (bug-specific): {total.harness_interventions}")
    print(f"  flaky                : {sum(1 for m in metas if m.reject_reason == 'flaky')}  "
          f"timeout: {sum(1 for m in metas if m.timed_out)}")
    print(f"\n  RECOMMENDATION: {verdict}\n    {why}")
    with open("pybughive_report_post_f2p_fix.json", "w") as fh:
        fh.write(total.model_dump_json(indent=2))
    print("  wrote pybughive_report_post_f2p_fix.json")


if __name__ == "__main__":
    main()
