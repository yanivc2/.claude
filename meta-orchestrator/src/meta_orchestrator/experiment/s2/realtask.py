"""Repo-backed real-task grading adapter (P0.6) — node-level public/hidden execution, network-isolated.

Reuses the FROZEN isolation model (the solver only ever sees a RoundView of source + sanitised public
feedback; hidden tests live behind a verifier-only boundary). For black-112 the P2P and F2P nodes
live in the SAME test file, so the mixed test file is NEVER handed to the solver / prompt / logs — it
stays inside the repo checkout, and only exact node ids are executed:

  * public runner → the frozen P2P node ids only → PASS / FAIL / NO_PUBLIC_TESTS / INFRA_ERROR, with a
    sanitised, <=2000-char summary (no raw test source, no hidden node id, no F2P content);
  * hidden verifier → the frozen F2P node only, run ONCE at the end → a boolean verdict, NEVER any
    traceback / node id / test content returned to the model, and it never opens Round 2.

Every pytest execution runs under ``unshare -rn`` — a real OS network namespace with no outbound
network / DNS — so the graded code cannot fetch anything mid-run. The Anthropic call happens OUTSIDE
this boundary (in the solver), never here.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from typing import Optional

from pydantic import BaseModel

from .gates import GateError

PUBLIC_FEEDBACK_CAP = 2000
_PYTEST_TIMEOUT = 300
# a real OS boundary: rootless network namespace with loopback down → no outbound TCP / DNS.
NETNS_PREFIX = ["unshare", "-rn"]


class PublicResult(BaseModel):
    status: str                      # PASS | FAIL | NO_PUBLIC_TESTS | INFRA_ERROR
    passed: bool
    tests_run: int
    sanitized_summary: str           # <=2000 chars, no raw source / hidden content


class RealTaskContext(BaseModel):
    task_id: str
    repo: str
    py: str
    allowed_source_files: list[str]
    p2p_nodes: list[str]             # PUBLIC node ids (visible-suite)
    f2p_plan: list[list]            # HIDDEN [[test_file, keyword|None], ...] — verifier-only
    buggy_source: dict[str, str]
    reference_fix: dict[str, str] = {}   # EVALUATOR-ONLY (write-gate leak screen); never solver-visible
    network_isolated: bool = True

    def netns(self) -> list[str]:
        return list(NETNS_PREFIX) if self.network_isolated else []


def _sanitize(text: str) -> str:
    """Strip absolute paths + collapse to a capped, content-light summary (no raw test source)."""
    text = re.sub(r"/[^\s:]+/", "", text)                 # drop absolute path prefixes
    keep = [ln for ln in text.splitlines()
            if re.search(r"(PASSED|FAILED|ERROR|passed|failed|error|==)", ln)]
    return ("\n".join(keep) or text)[:PUBLIC_FEEDBACK_CAP]


def _pytest(ctx: RealTaskContext, args: list[str]) -> tuple[dict, bool, str]:
    """Run pytest with the given selector args under the network namespace; parse per-node results."""
    cmd = ctx.netns() + [ctx.py, "-m", "pytest", "-o", "addopts=", "-rA", "--tb=line", "-q", *args]
    try:
        r = subprocess.run(cmd, cwd=ctx.repo, capture_output=True, text=True, timeout=_PYTEST_TIMEOUT)
        out = r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return {}, True, "TIMEOUT"
    res = {}
    for line in out.splitlines():
        m = re.match(r"(PASSED|FAILED|ERROR)\s+(\S+)", line)
        if m:
            res[m.group(2)] = m.group(1)
    return res, False, out


def _pytest_nodes(ctx: RealTaskContext, nodes: list[str]) -> tuple[dict, bool, str]:
    """Run EXACT node ids (the P2P public suite)."""
    if not nodes:
        return {}, False, ""
    return _pytest(ctx, list(nodes))


def _pytest_plan(ctx: RealTaskContext, plan: list) -> tuple[dict, bool, str]:
    """Run a [[test_file, keyword|None], ...] plan with ``-k`` KEYWORD semantics (the F2P hidden suite,
    exactly as repro.py selects it) — a keyword is NOT a node-id suffix."""
    merged: dict = {}
    timed_out = False
    raw = ""
    for test_file, keyword in plan:
        args = [test_file] + (["-k", keyword] if keyword else [])
        res, to, out = _pytest(ctx, args)
        merged.update(res)
        timed_out = timed_out or to
        raw += out
    return merged, timed_out, raw


def apply_patch(ctx: RealTaskContext, edits: dict[str, list]) -> None:
    """Apply minimal SEARCH/REPLACE edits to the ALLOWED source files, ALWAYS against the buggy
    pre-image the model was shown (never a test file, never stacked on a prior round).

    ``edits`` maps path -> [(search, replace), ...]. Both rounds show the buggy source, so each round's
    patch is authored against it; applying to ``ctx.buggy_source[path]`` (not the on-disk, possibly
    Round-1-patched file) keeps SEARCH anchored to exactly what the model saw. Exact-match/uniqueness/
    overlap are enforced by ``patch_format.apply_search_replace`` and raise ``PatchFormatError`` (a
    solver failure the runner records — NOT a transport ambiguity)."""
    from .patch_format import SearchReplace, apply_search_replace
    for path, blocks in edits.items():
        if path not in ctx.allowed_source_files:          # scope guard (patch can't touch tests)
            raise ValueError(f"patch path {path!r} outside allowed_source_files — rejected")
        pre_image = ctx.buggy_source[path]
        new_content = apply_search_replace(pre_image, [SearchReplace(s, r) for s, r in blocks])
        full = os.path.join(ctx.repo, path)
        with open(full, "w", encoding="utf-8") as fh:
            fh.write(new_content)


def reset_allowed_to_buggy(ctx: RealTaskContext) -> None:
    """Restore the allowed source files to the buggy pre-image (used before applying a round's patch
    so edits never stack, and to grade an unpatched/failed round honestly)."""
    for path in ctx.allowed_source_files:
        with open(os.path.join(ctx.repo, path), "w", encoding="utf-8") as fh:
            fh.write(ctx.buggy_source[path])


def run_public_tests(ctx: RealTaskContext) -> PublicResult:
    """Run ONLY the frozen P2P nodes; return a 4-state status + a sanitised capped summary."""
    if not ctx.p2p_nodes:
        return PublicResult(status="NO_PUBLIC_TESTS", passed=True, tests_run=0, sanitized_summary="")
    res, timed_out, raw = _pytest_nodes(ctx, ctx.p2p_nodes)
    if timed_out or (not res):
        return PublicResult(status="INFRA_ERROR", passed=False, tests_run=0,
                            sanitized_summary=_sanitize(raw))
    passed = all(v == "PASSED" for v in res.values())
    return PublicResult(status="PASS" if passed else "FAIL", passed=passed, tests_run=len(res),
                        sanitized_summary="" if passed else _sanitize(raw))


def _sha_list(items: list) -> str:
    return hashlib.sha256(json.dumps(sorted(items), sort_keys=True).encode()).hexdigest()[:16]


def collect_hidden_nodes(ctx: RealTaskContext) -> list[str]:
    """The EXACT test node ids the F2P ``-k`` selector collects (``--collect-only``)."""
    nodes: list[str] = []
    for test_file, keyword in ctx.f2p_plan:
        args = ["--collect-only", test_file] + (["-k", keyword] if keyword else [])
        _res, _to, out = _pytest(ctx, args)
        for line in out.splitlines():
            line = line.strip()
            if "::" in line and " " not in line and "PASSED" not in line and "FAILED" not in line:
                nodes.append(line)
    return sorted(set(nodes))


def hidden_selection_evidence(ctx: RealTaskContext) -> dict:
    """Freeze-able proof that the ``-k`` selector is well-formed (exactly the frozen F2P, no P2P)."""
    collected = collect_hidden_nodes(ctx)
    overlap = sorted(set(collected) & set(ctx.p2p_nodes))
    return {"f2p_plan": ctx.f2p_plan, "collected_hidden_nodes": collected,
            "hidden_match_count": len(collected), "p2p_count": len(ctx.p2p_nodes),
            "overlap_with_p2p": overlap,
            "hidden_node_plan_hash": _sha_list(collected),
            "public_node_plan_hash": _sha_list(list(ctx.p2p_nodes))}


def assert_hidden_selection_valid(ctx: RealTaskContext) -> dict:
    """Guard the ``-k`` selector: it MUST collect exactly one node, disjoint from the P2P suite.

    A 0- or >1-match is a CONFIGURATION failure (raises), NEVER a silent hidden FAIL — otherwise a
    mis-scoped selector could fabricate or hide a verdict.
    """
    ev = hidden_selection_evidence(ctx)
    if ev["hidden_match_count"] != 1:
        raise GateError(f"hidden -k selector matched {ev['hidden_match_count']} tests, expected "
                        "exactly 1 — configuration failure (not a hidden FAIL)")
    if ev["overlap_with_p2p"]:
        raise GateError(f"hidden selection overlaps the P2P suite {ev['overlap_with_p2p']} — blocked")
    return ev


def hidden_verify(ctx: RealTaskContext) -> bool:
    """Run ONLY the frozen F2P node, ONCE. Return a boolean verdict — NO content (traceback / node
    id / assertion) ever leaves this call. The ``-k`` selection is guarded to exactly one node first;
    a mis-scoped selector raises a configuration failure rather than returning a false FAIL."""
    ev = assert_hidden_selection_valid(ctx)
    node = ev["collected_hidden_nodes"][0]
    res, timed_out, _raw = _pytest(ctx, [node])           # run the EXACT collected node id
    if timed_out or not res:
        raise GateError("hidden node did not produce a result — infrastructure failure, not a FAIL")
    return all(v == "PASSED" for v in res.values())


def _materialize(task_id: str, workdir: str) -> RealTaskContext:
    """Build the repo-backed context via the frozen reproduce_bug pipeline (clone/venv/install)."""
    import json
    from .repro import reproduce_bug
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__))))))                      # → meta-orchestrator root
    fmap = json.load(open(os.path.join(here, "corpus", "s2_family_map.json")))["family_map"]
    scope = {t["task_id"]: t for t in
             json.load(open(os.path.join(here, "corpus", "s2_scope_metadata.json")))["tasks"]}
    pb = os.path.join(workdir, "_pybughive")
    if not os.path.isdir(pb):
        subprocess.run(["git", "clone", "-q", "--depth", "1",
                        "https://github.com/pybughive/pybughive", pb], check=True, timeout=300)
    dataset = json.load(open(os.path.join(pb, "dataset", "pybughive_current.json")))
    issue_by_id = {f"{p['repository']}-{iss['id']}": (p, iss)
                   for p in dataset for iss in p["issues"]}
    proj, iss = issue_by_id[task_id]
    sc = scope[task_id]
    task, rep = reproduce_bug(task_id, proj["repository"], proj["username"], iss, fmap[task_id],
                              sc["allowed_source_files"], sc["repair_scope"], workdir)
    if task is None:
        raise RuntimeError(f"reproduction failed for {task_id}: {rep.status} {rep.detail}")
    repo = os.path.join(workdir, proj["repository"])
    # leave the repo at the BUGGY state the agent starts from (allowed source only)
    subprocess.run(["git", "checkout", "-q", "-f", task.buggy_rev], cwd=repo, check=True)
    return RealTaskContext(task_id=task_id, repo=repo, py=os.path.join(repo, ".venv", "bin", "python"),
                           allowed_source_files=list(task.allowed_source_files),
                           p2p_nodes=list(task.p2p_nodes), f2p_plan=[list(p) for p in task.f2p_plan],
                           buggy_source=dict(task.buggy_source), reference_fix=dict(task.reference_fix))


def materialize_real_task(task_id: str, workdir: str) -> RealTaskContext:
    return _materialize(task_id, workdir)


class DryRunReport(BaseModel):
    task_id: str
    rounds: int
    public_statuses: list[str]
    round2_opened: bool
    hidden_verdict: bool             # verifier-only; computed AFTER the last attempt, never fed back
    patches_applied: int
    r1_prompt: str                   # what the solver saw at R1 (source + statement + memory only)
    r2_feedback: Optional[str] = None  # sanitised public summary fed into R2 (no hidden content)
    # isolation self-checks (asserted by tests):
    r1_prompt_has_test_file_content: bool
    r2_feedback_has_hidden_nodeid: bool


def dry_run_attempt(ctx: RealTaskContext, *, statement: str, memory_lines: list[str],
                    r1_text: str, r2_text: Optional[str] = None, is_train: bool = True,
                    mixed_test_file_marker: str = "") -> DryRunReport:
    """A FAKE-transport, real-execution attempt on the repo-backed task ($0 — no model call).

    The solver side is fed canned ``r1_text`` / ``r2_text`` (what a model WOULD return); the grading
    side is REAL (patch apply + node-level public/hidden pytest under network isolation). Proves the
    end-to-end downstream is valid before any paid call, and that hidden content never reaches the
    solver. Round 2 opens ONLY on a genuine public FAIL; the hidden verdict is computed last and is
    never fed back.
    """
    from .canary_prompt import build_r1_user_prompt, build_r2_messages
    from .response_parser import parse_model_response

    r1_prompt = build_r1_user_prompt(statement, ctx.buggy_source, memory_lines, train=is_train)
    statuses: list[str] = []
    patches = 0

    p1 = parse_model_response(r1_text, allowed_source_files=ctx.allowed_source_files,
                              task_family="", is_train=is_train)
    if p1.ok:
        apply_patch(ctx, p1.edits)
        patches += 1
    pub1 = run_public_tests(ctx)
    statuses.append(pub1.status)

    r2_feedback = None
    round2 = False
    if pub1.status == "FAIL" and r2_text is not None:      # R2 opens ONLY on a genuine public FAIL
        round2 = True
        r2_feedback = pub1.sanitized_summary
        _msgs = build_r2_messages(r1_prompt, r1_text, r2_feedback)
        p2 = parse_model_response(r2_text, allowed_source_files=ctx.allowed_source_files,
                                  task_family="", is_train=is_train)
        if p2.ok:
            apply_patch(ctx, p2.edits)
            patches += 1
        pub2 = run_public_tests(ctx)
        statuses.append(pub2.status)

    verdict = hidden_verify(ctx)                            # ONCE, at the end; never fed back

    marker = mixed_test_file_marker
    return DryRunReport(
        task_id=ctx.task_id, rounds=(2 if round2 else 1), public_statuses=statuses,
        round2_opened=round2, hidden_verdict=verdict, patches_applied=patches, r1_prompt=r1_prompt,
        r2_feedback=r2_feedback,
        r1_prompt_has_test_file_content=bool(marker) and marker in r1_prompt,
        r2_feedback_has_hidden_nodeid=bool(r2_feedback) and any(
            (kw and kw in (r2_feedback or "")) for _tf, kw in ctx.f2p_plan))
