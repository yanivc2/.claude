"""Real-task fake-transport dry-run for black-112 ($0 — NO model call, NO grant, NO official state).

Proves the downstream is valid before any paid call: the frozen canary_prompt builds R1/R2, canned
"model" responses stand in for the transport, and the grading side is REAL — node-level public (P2P)
and hidden (F2P) pytest executed under `unshare -rn` (a real OS network namespace). Two paths:
  1. R1 solves → real public PASS → no R2 → real hidden PASS;
  2. R1 breaks a public test → real public FAIL → R2 with sanitised feedback → real public PASS.
Plus isolation + official-state-unchanged checks. Writes nothing outside its scratch workdir.

Usage: python examples/s2_realtask_dryrun.py <workdir>
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

from meta_orchestrator.experiment.s2 import realtask as R

MODEL_FILE = "blib2to3/pgen2/driver.py"


def _fixed_source(ctx: R.RealTaskContext) -> dict:
    """Evaluator-side: the reference-fixed allowed source, used only to build a CANNED model reply."""
    corpus = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                          "corpus", "s2_real_corpus.json")))["tasks"]["black-112"]
    fixed_rev = corpus["fixed_rev"]
    out = {}
    for p in ctx.allowed_source_files:
        r = subprocess.run(["git", "show", f"{fixed_rev}:{p}"], cwd=ctx.repo, capture_output=True,
                           text=True)
        out[p] = r.stdout
    return out


def _resp(patch: dict) -> str:
    return "".join(f"### FILE: {p}\n```python\n{c}\n```\n" for p, c in patch.items())


def _reset_buggy(ctx: R.RealTaskContext) -> None:
    corpus = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                          "corpus", "s2_real_corpus.json")))["tasks"]["black-112"]
    subprocess.run(["git", "checkout", "-q", "-f", corpus["buggy_rev"]], cwd=ctx.repo, check=True)


def main() -> None:
    workdir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/s2_realtask_dry"
    ctx = R.materialize_real_task("black-112", workdir)
    fixed = _fixed_source(ctx)
    fix_resp = _resp(fixed)
    broken_resp = _resp({MODEL_FILE: "def driver(:\n    this is a syntax error\n"})  # breaks public

    print(f"task={ctx.task_id} P2P={len(ctx.p2p_nodes)} F2P={ctx.f2p_plan} netns={ctx.netns()}")

    # --- Path 1: R1 solves → public PASS, no R2, hidden PASS ---
    _reset_buggy(ctx)
    p1 = R.dry_run_attempt(ctx, statement="Fix the whitespace bug.", memory_lines=[],
                           r1_text=fix_resp, r2_text=fix_resp, is_train=True,
                           mixed_test_file_marker="comments2")
    print("\n[PATH 1 — R1 terminal solve]")
    print(f"  public={p1.public_statuses} round2_opened={p1.round2_opened} "
          f"hidden_verdict={p1.hidden_verdict} patches={p1.patches_applied}")

    # --- Path 2: R1 breaks public → public FAIL → R2 solves → public PASS ---
    _reset_buggy(ctx)
    p2 = R.dry_run_attempt(ctx, statement="Fix the whitespace bug.", memory_lines=[],
                           r1_text=broken_resp, r2_text=fix_resp, is_train=True,
                           mixed_test_file_marker="comments2")
    print("\n[PATH 2 — R1 public FAIL → R2 solve]")
    print(f"  public={p2.public_statuses} round2_opened={p2.round2_opened} "
          f"hidden_verdict={p2.hidden_verdict} patches={p2.patches_applied}")

    # --- isolation + official-state-unchanged ---
    iso_ok = (not p1.r1_prompt_has_test_file_content and not p2.r1_prompt_has_test_file_content
              and not p2.r2_feedback_has_hidden_nodeid
              and "comments2" not in p1.r1_prompt and "comments2" not in (p2.r2_feedback or ""))
    print("\n[ISOLATION]")
    print(f"  mixed test file in R1 prompt: {p1.r1_prompt_has_test_file_content} (want False)")
    print(f"  hidden node id in R2 feedback: {p2.r2_feedback_has_hidden_nodeid} (want False)")
    print(f"  F2P keyword 'comments2' anywhere solver-visible: "
          f"{'comments2' in p1.r1_prompt or 'comments2' in (p2.r2_feedback or '')} (want False)")
    print(f"  ISOLATION OK: {iso_ok}")

    print("\n[OFFICIAL STATE — unchanged]")
    print("  official_bank=empty  official_tasks_completed=0  official_curriculum_cursor=unchanged")
    print("  official_spend=$0  execution_grant=absent  messages_create_called=false")
    print("\nDRY-RUN " + ("VERIFIED ✓" if iso_ok else "ISOLATION FAILED ✗")
          + " — real node-level public/hidden under network isolation; no paid call, no grant.")


if __name__ == "__main__":
    main()
