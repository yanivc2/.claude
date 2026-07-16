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


def _load_prior(path: str):
    """Load previously-saved candidate metadata (e.g. the small-slice run) for a cumulative view."""
    if not os.path.exists(path):
        return []
    data = json.load(open(path))
    return [CandidateMeta(**c) for c in data.get("candidates", [])]


def main() -> None:
    # This round's expansion: black ONLY (objective pre-registered pick: pure-Python, light
    # install, large corpus). No auto-move to other projects. Cumulative view merges the prior
    # pybughive_small slice so the GATE decision is on all evidence gathered so far.
    projects = sys.argv[1:] or ["black"]

    work = tempfile.mkdtemp(prefix="pbh_qual_")
    meta_repo = os.path.join(work, "_pybughive")
    _run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, meta_repo], timeout=300)
    data = json.load(open(os.path.join(meta_repo, "dataset", "pybughive_current.json")))

    print("=== QUALIFIER INFRASTRUCTURE ===")
    print("  pure helpers unit-tested offline (`pytest tests/test_pybughive_qual.py`).")
    print(f"  this run: model-free, $0 API. Projects this round: {projects}.")
    print("  harness interventions (bug-specific manual fixes): NONE — one GENERAL, documented "
          "methodology fix only (overlay ALL fix test artifacts incl. fixtures).\n")
    print("=== CORPUS QUALIFICATION RESULTS (real bugs) ===")

    fresh = []
    for project in projects:
        proj = next((p for p in data if p["repository"] == project), None)
        if proj is None:
            print(f"\n--- {project}: not found in dataset, skipped ---")
            continue
        metas = []
        for iss in proj["issues"]:
            try:
                metas.append(qualify_bug(project, iss, work))
            except Exception as exc:  # a single bug's crash never kills the slice
                metas.append(CandidateMeta(candidate_id=f"{project}-{iss['id']}", project=project,
                                           issue=iss["id"], reject_reason=f"error:{type(exc).__name__}"))
                print(f"  {project}-{iss['id']}: ERROR {type(exc).__name__}: {exc}")
        _print_project(project, metas)
        fresh.extend(metas)

    prior = _load_prior("pybughive_report_small.json")
    cumulative = prior + fresh
    total = build_report("cumulative", cumulative)
    verdict, why = recommend(total)

    def _nonrepro_breakdown(metas):
        cls = [m.nonrepro_class for m in metas if m.nonrepro_class]
        from collections import Counter
        return dict(Counter(cls))

    print("\n" + "=" * 70)
    print(f"=== UNIFIED §3 REPORT (cumulative: prior small-slice + {projects}) ===")
    print(f"  candidates          : {total.total}   (this round {len(fresh)}, prior {len(prior)})")
    print(f"  reproducible        : {total.reproducible}")
    print(f"  admitted            : {total.admitted}   yield={total.admitted}/{total.total}")
    print(f"  high-learning-value : {total.high_learning_value}  (descriptive tier, NOT a gate)")
    print(f"  fingerprints ADMITTED: {total.fingerprints_admitted}")
    print(f"  fingerprints REJECTED: {total.fingerprints_rejected}")
    print(f"  rejection reasons    : {total.reject_reasons}")
    print(f"  non-repro breakdown  : {_nonrepro_breakdown(cumulative)}")
    print(f"  harness interventions (bug-specific): {total.harness_interventions}")
    n_timeout = sum(1 for m in cumulative if m.timed_out)
    n_flaky = sum(1 for m in cumulative if m.reject_reason == "flaky")
    print(f"  flaky/timeout        : flaky={n_flaky} timeout={n_timeout}")
    print(f"\n  RECOMMENDATION: {verdict}\n    {why}")
    with open("pybughive_report_cumulative.json", "w") as fh:
        fh.write(total.model_dump_json(indent=2))
    print("  wrote pybughive_report_cumulative.json")


if __name__ == "__main__":
    main()
