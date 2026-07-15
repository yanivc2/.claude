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
)

PYBUGHIVE_REPO = "https://github.com/pybughive/pybughive"
_EXC_LINE = re.compile(r"\b([A-Z][A-Za-z]*(?:Error|Exception))\b")


def _run(cmd: list[str], cwd: str | None = None, env: dict | None = None, timeout: int = 600):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def _pytest_nodes(py: str, cwd: str, test_files: list[str]) -> tuple[dict[str, str], str]:
    """Run the given test files, return {nodeid: PASSED|FAILED|ERROR} and raw output."""
    r = _run([py, "-m", "pytest", "-o", "addopts=", "-rA", "--tb=line", "-q", *test_files],
             cwd=cwd, timeout=600)
    out = r.stdout + r.stderr
    nodes: dict[str, str] = {}
    for line in out.splitlines():
        m = re.match(r"(PASSED|FAILED|ERROR)\s+(\S+)", line)
        if m:
            nodes[m.group(2)] = m.group(1)
    return nodes, out


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
    inst = _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=900)
    meta.installed = inst.returncode == 0
    if not meta.installed:
        meta.runtime_s = round(time.time() - t0, 1)
        meta.fingerprint = fingerprint("", patch_text, src_paths)
        return meta

    buggy1, out_b1 = _pytest_nodes(py, repo, test_paths)
    buggy2, _ = _pytest_nodes(py, repo, test_paths)

    # FIXED state: overlay fixed src too.
    _checkout(repo, fixed, src_paths)
    _run([py, "-m", "pip", "install", "-q", "-e", "."], cwd=repo, timeout=900)
    fixed1, _ = _pytest_nodes(py, repo, test_paths)
    fixed2, _ = _pytest_nodes(py, repo, test_paths)

    # Stability: same verdict across the two runs of each revision.
    common = set(buggy1) & set(buggy2) & set(fixed1) & set(fixed2)
    stable = all(buggy1[n] == buggy2[n] and fixed1[n] == fixed2[n] for n in common)
    # F2P nodes: consistently FAILED on buggy, consistently PASSED on fixed.
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


def main() -> None:
    project = sys.argv[1] if len(sys.argv) > 1 else "cookiecutter"
    max_bugs = int(sys.argv[2]) if len(sys.argv) > 2 else 15

    work = tempfile.mkdtemp(prefix="pbh_qual_")
    meta_repo = os.path.join(work, "_pybughive")
    _run(["git", "clone", "-q", "--depth", "1", PYBUGHIVE_REPO, meta_repo], timeout=300)
    data = json.load(open(os.path.join(meta_repo, "dataset", "pybughive_current.json")))
    proj = next(p for p in data if p["repository"] == project)
    issues = proj["issues"][:max_bugs]

    print(f"=== PyBugHive free qualification: {project} ({len(issues)} bugs, cap {max_bugs}) ===")
    metas = []
    for iss in issues:
        meta = qualify_bug(project, iss, work)
        metas.append(meta)
        print(f"  {meta.candidate_id:22s} installed={meta.installed!s:5s} "
              f"reproducible={meta.reproducible!s:5s} stable={meta.stable!s:5s} "
              f"fp={meta.fingerprint or '-':11s} patch={meta.patch.files}f/"
              f"{meta.patch.changed_lines}l/{meta.patch.hunks}h deg={meta.degenerate!s:5s} "
              f"{meta.runtime_s}s")

    report = build_report(project, metas)
    print(f"\n=== §3 report: total={report.total} admitted={report.admitted} "
          f"rejected={report.rejected} reproducible={report.reproducible} ===")
    print(f"  fingerprints  admitted: {report.fingerprints_admitted}")
    print(f"  fingerprints  rejected: {report.fingerprints_rejected}")
    print("  reject reasons:", dict((r, sum(1 for m in metas if m.reject_reason == r))
                                    for r in {m.reject_reason for m in metas if m.reject_reason}))
    out_path = f"pybughive_report_{project}.json"
    with open(out_path, "w") as fh:
        fh.write(report.model_dump_json(indent=2))
    print(f"\n  wrote {out_path}")
    print("  NOTE: baseline_success & failure_reason are NOT here — they need budgeted "
          "solver runs (next, gated on this GO/NO-GO).")


if __name__ == "__main__":
    main()
