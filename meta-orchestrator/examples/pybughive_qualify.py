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


def _pytest_nodes(py: str, cwd: str, test_files: list[str]) -> tuple[dict[str, str], str, bool]:
    """Run the given test files → {nodeid: PASSED|FAILED|ERROR}, raw output, timed_out."""
    r = _run([py, "-m", "pytest", "-o", "addopts=", "-rA", "--tb=line", "-q", *test_files],
             cwd=cwd, timeout=300)
    nodes: dict[str, str] = {}
    for line in r.stdout.splitlines():
        m = re.match(r"(PASSED|FAILED|ERROR)\s+(\S+)", line)
        if m:
            nodes[m.group(2)] = m.group(1)
    return nodes, r.stdout, r.timed_out


def _checkout(repo: str, ref: str, paths: list[str] | None = None) -> None:
    if paths:
        _run(["git", "checkout", "-q", ref, "--", *paths], cwd=repo)
    else:
        _run(["git", "checkout", "-q", "-f", ref], cwd=repo)


def qualify_bug(project: str, issue: dict, workdir: str) -> CandidateMeta:
    commit = issue["commits"][0]
    fixed = commit["hash"]
    buggy = commit["parents"].split(",")[0].strip()   # fix's parent = buggy revision
    files = commit["stat"].get("files", [])
    src_files = [f for f in files if not f["filename"].endswith((".md", ".rst", ".txt"))
                 and "test" not in f["filename"].lower()]
    src_paths = [f["filename"] for f in src_files]
    # Overlay ALL fix test artifacts (including .yaml/.png/.txt fixtures the tests read);
    # only .py files are actually run. Missing a fixture turns a clean F2P into an ERROR.
    test_overlay = [t["filename"] for t in commit["stat"].get("tests", [])]
    test_paths = [t for t in test_overlay if t.endswith(".py")]
    patch_text = "\n".join(f.get("patch", "") for f in src_files)
    m = patch_metrics(src_files)
    meta = CandidateMeta(
        candidate_id=f"{project}-{issue['id']}", project=project, issue=issue["id"],
        patch=m, degenerate=is_degenerate(m),
    )
    if not src_paths or not test_paths:
        meta.installed, meta.reject_reason = False, "no_src_or_test_in_patch"
        meta.fingerprint = fingerprint("", patch_text, src_paths)
        return meta

    t0 = time.time()
    repo = os.path.join(workdir, project)
    if not os.path.isdir(repo):
        gh = {"cookiecutter": "cookiecutter/cookiecutter", "scrapy": "scrapy/scrapy",
              "discord.py": "Rapptz/discord.py", "poetry": "python-poetry/poetry"}[project]
        _run(["git", "clone", "-q", f"https://github.com/{gh}", repo], timeout=600)
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

    tt = time.time()
    buggy1, out_b1, to1 = _pytest_nodes(py, repo, test_paths)
    buggy2, _, to2 = _pytest_nodes(py, repo, test_paths)
    _checkout(repo, fixed, src_paths)                       # FIXED state: overlay fixed src too.
    _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=600)
    fixed1, _, to3 = _pytest_nodes(py, repo, test_paths)
    fixed2, _, to4 = _pytest_nodes(py, repo, test_paths)
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
    meta.fingerprint = fingerprint(out_b1 if f2p else "", patch_text, src_paths)
    meta.runtime_s = round(time.time() - t0, 1)
    return meta


def _reject_reasons(metas):
    return dict(sorted(((r, sum(1 for m in metas if m.reject_reason == r))
                        for r in {m.reject_reason for m in metas if m.reject_reason}),
                       key=lambda kv: -kv[1]))


def _print_project(name, metas):
    report = build_report(name, metas)
    yield_rate = f"{report.admitted}/{report.total}"
    print(f"\n--- {name}: candidates={report.total} admitted={report.admitted} "
          f"(yield {yield_rate}) reproducible={report.reproducible} ---")
    for m in metas:
        p = m.patch
        print(f"  {m.candidate_id:22s} inst={m.installed!s:5s} repro={m.reproducible!s:5s} "
              f"stable={m.stable!s:5s} fp={m.fingerprint or '-':11s} "
              f"patch={p.files}f/{p.changed_lines}l/{p.hunks}h deg={m.degenerate!s:5s} "
              f"inst_s={m.install_s} test_s={m.test_s} runs={m.n_test_runs} "
              f"{'TIMEOUT ' if m.timed_out else ''}{'ADMIT' if m.admitted else 'reject:'+m.reject_reason}")
    print(f"  reject reasons: {_reject_reasons(metas)}")
    return report


def main() -> None:
    # Bounded slice = the 4 projects in pybughive_small.json. NO expansion beyond these.
    SLICE = ["cookiecutter", "scrapy", "discord.py", "poetry"]
    only = sys.argv[1:] or SLICE

    work = tempfile.mkdtemp(prefix="pbh_qual_")
    meta_repo = os.path.join(work, "_pybughive")
    _run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, meta_repo], timeout=300)
    data = json.load(open(os.path.join(meta_repo, "dataset", "pybughive_small.json")))

    print("=== QUALIFIER INFRASTRUCTURE ===")
    print("  offline unit tests: run `pytest tests/test_pybughive_qual.py` (pure helpers).")
    print("  this run: model-free, $0 API. Bounded to pybughive_small.json (4 projects).\n")
    print("=== CORPUS QUALIFICATION RESULTS (real bugs) ===")

    all_metas = []
    for project in only:
        proj = next((p for p in data if p["repository"] == project), None)
        if proj is None:
            print(f"\n--- {project}: not in pybughive_small.json, skipped ---")
            continue
        metas = []
        for iss in proj["issues"]:
            try:
                metas.append(qualify_bug(project, iss, work))
            except Exception as exc:  # a single bug's crash never kills the slice
                m = CandidateMeta(candidate_id=f"{project}-{iss['id']}", project=project,
                                  issue=iss["id"], reject_reason=f"error:{type(exc).__name__}")
                metas.append(m)
                print(f"  {m.candidate_id}: ERROR {type(exc).__name__}: {exc}")
        _print_project(project, metas)
        all_metas.extend(metas)

    total = build_report("small", all_metas)
    verdict, why = recommend(total)
    print("\n" + "=" * 70)
    print(f"=== UNIFIED §3 REPORT (slice=pybughive_small, {len(only)} projects) ===")
    print(f"  candidates={total.total}  admitted={total.admitted}  "
          f"yield={total.admitted}/{total.total}  reproducible={total.reproducible}")
    print(f"  fingerprints ADMITTED (diversity): {total.fingerprints_admitted}")
    print(f"  fingerprints REJECTED:             {total.fingerprints_rejected}")
    print(f"  reject reasons (all): {_reject_reasons(all_metas)}")
    print(f"\n  RECOMMENDATION: {verdict}\n    {why}")
    print("\n  Tiers are distinct: reproducible ⊇ admitted ⊇ (high-learning-value, NOT yet a "
          "gate). Learning-value components shown per-candidate (patch size, hunks, fingerprint) "
          "but NOT auto-thresholded. baseline_success & failure_reason require budgeted solver "
          "runs — NOT run here.")
    with open("pybughive_report_small.json", "w") as fh:
        fh.write(total.model_dump_json(indent=2))
    print("  wrote pybughive_report_small.json")


if __name__ == "__main__":
    main()
