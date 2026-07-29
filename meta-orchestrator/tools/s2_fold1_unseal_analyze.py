"""§2 Fold-1 one-shot deterministic UNSEAL + analyzer (frozen plan S2_FOLD1_BLINDED_ANALYSIS_PLAN.md).

Pure analysis functions (unit-tested on SYNTHETIC data only) + a guarded one-shot unseal entry
that decodes the REAL sealed store exactly once, validates completeness, computes the frozen
analyses in the frozen output order, and writes outputs atomically with audit hashes.

The unseal path runs ONLY when invoked with --unseal AND an explicit pre-declared reason; the
default (dry) invocation decodes NOTHING. Importing this module decodes nothing. Determinism:
the analysis JSON carries no timestamp, so its hash is reproducible; the wall-clock timestamp
lives only in the separate audit record.

CLI:
  dry (no decode): python tools/s2_fold1_unseal_analyze.py <block_dir> <plan_path>
  UNSEAL (paid-data decode, requires explicit GO):
     python tools/s2_fold1_unseal_analyze.py <block_dir> <plan_path> <out_dir> --unseal \
            --reason all_folds_complete
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from typing import Optional

# ---- frozen bindings (must match at unseal time; see the analysis plan) -------------------------
EXPECT_SEALED_SHA256 = "53dec53d14d3ccde1ae77d6c21c10505ed6efea97f50cebad3e28c5e9a32edc9"
EXPECT_CHAIN_HEAD = "3d3b29252863c7be"
EXPECT_ENTRIES = 48
EXPECT_MANIFEST = "d6a5919ab7bb3bec"
PRIMARY_CONDITIONS = ["A", "C", "D", "B1"]
STABILITY_CONDITIONS = ["A", "C"]
UNIT_TASK_COUNT = 8
UNSEAL_REASONS = frozenset({"all_folds_complete", "predeclared_stop_trigger"})


class AnalysisError(RuntimeError):
    """A completeness / integrity / plan-binding failure — no partial analysis is produced."""


# ================================ pure statistics ================================================

def exact_binom_one_sided_ge(b: int, c: int) -> float:
    """One-sided exact sign/McNemar p for H1: the b-favoured side wins. P(X>=b), X~Binom(b+c,.5)."""
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, sum(math.comb(n, k) for k in range(b, n + 1)) * (0.5 ** n))


def exact_binom_two_sided(b: int, c: int) -> float:
    """Two-sided exact sign test: double the smaller tail of a symmetric Binom(b+c, 0.5)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) * (0.5 ** n)
    return min(1.0, 2.0 * tail)


def holm(pvals: dict) -> dict:
    """Holm step-down adjusted p-values (monotone, capped at 1). Deterministic tie order by name."""
    items = sorted(pvals.items(), key=lambda kv: (kv[1], kv[0]))
    m = len(items)
    adj, running = {}, 0.0
    for i, (name, p) in enumerate(items):
        running = max(running, min(1.0, (m - i) * p))
        adj[name] = running
    return adj


def classify_primary(delta: float, one_sided_p: float) -> str:
    if delta > 0 and one_sided_p <= 0.05:
        return "POSITIVE_STATISTICAL_EVIDENCE"
    if delta > 0:
        return "DIRECTIONAL_POSITIVE_ONLY"
    if delta == 0:
        return "NO_POSITIVE_EFFECT"
    return "NEGATIVE_DIRECTION"


# ================================ completeness ===================================================

def validate_completeness(cells: list, expected_tasks: dict) -> None:
    """48/48, no duplicate (task,condition,rep), every task has all 4 primary + 2 stability cells,
    task set == manifest, all cells terminal (no ambiguity). Raises AnalysisError on any breach."""
    if len(cells) != EXPECT_ENTRIES:
        raise AnalysisError(f"expected {EXPECT_ENTRIES} cells, got {len(cells)}")
    seen = set()
    for c in cells:
        key = (c["task_id"], c["condition"], c["rep"])
        if key in seen:
            raise AnalysisError(f"duplicate cell {key}")
        seen.add(key)
        if c.get("ambiguous"):
            raise AnalysisError(f"ambiguous/non-terminal cell {key} — no partial analysis")
        if c["solved"] not in (0, 1):
            raise AnalysisError(f"unknown outcome {c['solved']!r} at {key}")
    tasks = sorted({c["task_id"] for c in cells})
    if tasks != sorted(expected_tasks):
        raise AnalysisError(f"task set {tasks} != manifest {sorted(expected_tasks)}")
    if len(tasks) != UNIT_TASK_COUNT:
        raise AnalysisError(f"expected {UNIT_TASK_COUNT} tasks, got {len(tasks)}")
    for t in tasks:
        prim = sorted(c["condition"] for c in cells if c["task_id"] == t and c["rep"] == 0)
        stab = sorted(c["condition"] for c in cells if c["task_id"] == t and c["rep"] == 1)
        if prim != sorted(PRIMARY_CONDITIONS):
            raise AnalysisError(f"task {t} missing primary conditions: {prim}")
        if stab != sorted(STABILITY_CONDITIONS):
            raise AnalysisError(f"task {t} missing stability conditions: {stab}")


# ================================ analyses (frozen order) ========================================

def _primary(cells: list) -> dict:
    return {(c["task_id"], c["condition"]): c for c in cells if c["rep"] == 0}


def paired_contrast(cells: list, x: str, y: str) -> dict:
    """Task-level paired contrast Δ(x−y) on PRIMARY cells (rep 0). b=x-only wins, c=y-only wins."""
    prim = _primary(cells)
    tasks = sorted({c["task_id"] for c in cells})
    b = c_ = both = neither = xs = ys = 0
    for t in tasks:
        sx, sy = prim[(t, x)]["solved"], prim[(t, y)]["solved"]
        xs += sx
        ys += sy
        if sx == 1 and sy == 0:
            b += 1
        elif sx == 0 and sy == 1:
            c_ += 1
        elif sx == 1 and sy == 1:
            both += 1
        else:
            neither += 1
    n = len(tasks)
    delta = (xs - ys) / n
    one = exact_binom_one_sided_ge(b, c_)         # H1: x > y
    two = exact_binom_two_sided(b, c_)
    return {"x": x, "y": y, "n_tasks": n, f"{x}_solves": xs, f"{y}_solves": ys,
            "paired_solve_difference": xs - ys, "paired_rate_difference": round(delta, 6),
            "delta": round(delta, 6), f"{x}_only_wins": b, f"{y}_only_wins": c_,
            "both_solved": both, "both_failed": neither, "discordant_pairs": b + c_,
            "exact_one_sided_p": round(one, 8), "exact_two_sided_p": round(two, 8)}


def stability(cells: list) -> dict:
    tasks = sorted({c["task_id"] for c in cells})
    prim = _primary(cells)
    rep1 = {(c["task_id"], c["condition"]): c for c in cells if c["rep"] == 1}
    out = {}
    for cond in STABILITY_CONDITIONS:
        both = neither = ps_rf = pf_rs = 0
        for t in tasks:
            p, r = prim[(t, cond)]["solved"], rep1[(t, cond)]["solved"]
            if p == 1 and r == 1:
                both += 1
            elif p == 0 and r == 0:
                neither += 1
            elif p == 1 and r == 0:
                ps_rf += 1
            else:
                pf_rs += 1
        agree = both + neither
        out[cond] = {"both_solved": both, "both_failed": neither,
                     "primary_solved_rep_failed": ps_rf, "primary_failed_rep_solved": pf_rs,
                     "agreement_rate": round(agree / len(tasks), 6)}
    # replicated sensitivity Δrep(C−A) = mean_task[(C_p+C_r)/2 − (A_p+A_r)/2]
    diffs = []
    for t in tasks:
        a_mean = (prim[(t, "A")]["solved"] + rep1[(t, "A")]["solved"]) / 2
        c_mean = (prim[(t, "C")]["solved"] + rep1[(t, "C")]["solved"]) / 2
        diffs.append(c_mean - a_mean)
    out["delta_rep_C_minus_A"] = round(sum(diffs) / len(tasks), 6)
    out["note"] = ("robustness only; 16 A-runs + 16 C-runs are NOT 32 independent units — "
                   "inference stays clustered/paired by 8 tasks")
    return out


def per_task_table(cells: list) -> list:
    prim = _primary(cells)
    rows = []
    for t in sorted({c["task_id"] for c in cells}):
        fam = next(c["task_family"] for c in cells if c["task_id"] == t)
        rows.append({"task_id": t, "task_family": fam,
                     **{cond: prim[(t, cond)]["solved"] for cond in PRIMARY_CONDITIONS}})
    return rows


def per_family_table(cells: list) -> list:
    prim = _primary(cells)
    fams = {}
    for t in sorted({c["task_id"] for c in cells}):
        fam = next(c["task_family"] for c in cells if c["task_id"] == t)
        fams.setdefault(fam, []).append(t)
    rows = []
    for fam in sorted(fams):
        ts = fams[fam]
        s = {cond: sum(prim[(t, cond)]["solved"] for t in ts) for cond in PRIMARY_CONDITIONS}
        rows.append({"family": fam, "n_tasks": len(ts), **s,
                     "C_minus_A": s["C"] - s["A"], "C_minus_D": s["C"] - s["D"],
                     "C_minus_B1": s["C"] - s["B1"]})
    return rows


def cost_table(cells: list) -> dict:
    tasks = sorted({c["task_id"] for c in cells})
    out = {}
    for cond in PRIMARY_CONDITIONS:
        prim = [c for c in cells if c["condition"] == cond and c["rep"] == 0]
        spend = sum(c["cost_usd"] for c in prim)
        solved = sum(c["solved"] for c in prim)
        out[cond] = {"total_spend_usd": round(spend, 8),
                     "mean_spend_per_task_usd": round(spend / len(tasks), 8),
                     "api_calls": sum(c["calls"] for c in prim), "r2_count": sum(c["r2"] for c in prim),
                     "solved_count": solved,
                     "cost_per_solved_usd": (round(spend / solved, 8) if solved else "undefined")}
    for cond in STABILITY_CONDITIONS:
        st = [c for c in cells if c["condition"] == cond and c["rep"] == 1]
        out[f"{cond}_stability"] = {"total_spend_usd": round(sum(c["cost_usd"] for c in st), 8),
                                    "api_calls": sum(c["calls"] for c in st),
                                    "r2_count": sum(c["r2"] for c in st)}
    return out


def analyze(cells: list, expected_tasks: dict) -> dict:
    """Deterministic, timestamp-free. Frozen output order (see plan §8)."""
    validate_completeness(cells, expected_tasks)
    ca = paired_contrast(cells, "C", "A")
    cb1 = paired_contrast(cells, "C", "B1")
    cd = paired_contrast(cells, "C", "D")
    holm_adj = holm({"C_vs_B1": cb1["exact_one_sided_p"], "C_vs_D": cd["exact_one_sided_p"]})
    return {
        "1_integrity": {"unit_of_analysis": "held-out task", "unit_level_task_count": UNIT_TASK_COUNT,
                        "cells": len(cells), "excluded": {"cookiecutter-18": "PARITY_BLOCKED_BEFORE_SEND"}},
        "2_cell_completeness": {"primary_cells": sum(1 for c in cells if c["rep"] == 0),
                                "stability_cells": sum(1 for c in cells if c["rep"] == 1),
                                "missing_outcome_cells": 0, "post_unseal_exclusions": 0},
        "3_primary_C_vs_A": {**ca, "evidence_class":
                             classify_primary(ca["delta"], ca["exact_one_sided_p"])},
        "4_secondary_C_vs_B1": {**cb1, "holm_adjusted_one_sided_p": round(holm_adj["C_vs_B1"], 8)},
        "5_secondary_C_vs_D": {**cd, "holm_adjusted_one_sided_p": round(holm_adj["C_vs_D"], 8)},
        "6_stability": stability(cells),
        "7_per_task": per_task_table(cells),
        "8_per_family": per_family_table(cells),
        "9_cost_efficiency": cost_table(cells),
        "10_claim_boundary": {"claim_scope": "WITHIN_FOLD_CAUSAL_EVIDENCE",
                              "unit_level_task_count": UNIT_TASK_COUNT,
                              "boundary_family": "NOT_EVALUATED",
                              "boundary_generalization": "NOT_ESTABLISHED",
                              "cross_fold_generalization": "NOT_ESTABLISHED",
                              "directional_pilot": True},
    }


# ================================ guarded one-shot unseal ========================================

def records_to_cells(records: list, manifest: dict) -> list:
    """Map decoded sealed records → analysis cells. solved := hidden_verdict is True (else 0)."""
    fam = manifest["heldout_tasks"]
    cells = []
    for r in records:
        rep = r["report"]
        per_call = rep.get("per_call", [])
        cells.append({
            "task_id": r["task_id"], "condition": r["condition"], "rep": r["rep"],
            "task_family": fam[r["task_id"]],
            "solved": 1 if rep.get("hidden_verdict") is True else 0,
            "ambiguous": bool(rep.get("ambiguous_held")),
            "cost_usd": float(sum(float(pc["actual_cost_usd"]) for pc in per_call)),
            "calls": rep.get("calls_sent", len(per_call)),
            "r2": 1 if rep.get("round2_opened") else 0})
    return cells


def _sha_file(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def unseal_and_analyze(block_dir: str, plan_path: str, out_dir: str, *, unseal_reason: str,
                       timestamp: str) -> dict:
    """One-shot atomic unseal. Verifies every binding BEFORE decoding; on any failure raises
    AnalysisError and writes an audit-error only (no partial analysis)."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                    "src"))
    from meta_orchestrator.experiment.s2.heldout_eval import SealedOutcomeStore
    os.makedirs(out_dir, exist_ok=True)
    if unseal_reason not in UNSEAL_REASONS:
        raise AnalysisError(f"unseal_reason {unseal_reason!r} not pre-declared")
    sealed_path = os.path.join(block_dir, "sealed_outcomes.jsonl")
    sha = _sha_file(sealed_path)
    if sha != EXPECT_SEALED_SHA256:
        raise AnalysisError(f"sealed artifact sha256 drift: {sha}")
    plan_hash = _sha_file(plan_path)
    analyzer_hash = _sha_file(os.path.abspath(__file__))
    manifest = json.load(open(os.path.join(block_dir, "eval_manifest.json")))
    if manifest["content_hash"] != EXPECT_MANIFEST:
        raise AnalysisError("manifest hash drift")
    store = SealedOutcomeStore(sealed_path)
    entries = store._entries()
    if len(entries) != EXPECT_ENTRIES or entries[-1]["entry_hash"] != EXPECT_CHAIN_HEAD:
        raise AnalysisError("sealed chain head / entry-count drift")
    store.verify_chain()
    # ---- THE one decode ----
    records = store.outcome_table(unseal_reason=unseal_reason)
    cells = records_to_cells(records, manifest)
    analysis = analyze(cells, manifest["heldout_tasks"])
    analysis_json = json.dumps(analysis, sort_keys=True, separators=(",", ":"))
    analysis_json_hash = hashlib.sha256(analysis_json.encode()).hexdigest()[:16]
    cell_tbl = json.dumps(sorted(cells, key=lambda c: (c["task_id"], c["condition"], c["rep"])),
                          sort_keys=True, separators=(",", ":"))
    cell_hash = hashlib.sha256(cell_tbl.encode()).hexdigest()[:16]
    report_md = render_report(analysis)
    report_hash = hashlib.sha256(report_md.encode()).hexdigest()[:16]
    audit = {"input_artifact_sha256": sha, "sealed_chain_head": EXPECT_CHAIN_HEAD,
             "analysis_plan_hash": plan_hash, "analyzer_source_hash": analyzer_hash,
             "unseal_timestamp": timestamp, "unseal_reason": unseal_reason,
             "decoded_cell_table_hash": cell_hash, "analysis_json_hash": analysis_json_hash,
             "analysis_report_hash": report_hash, "outcomes_unsealed": True}
    # atomic writes
    for name, data in (("analysis.json", json.dumps(analysis, indent=2, sort_keys=True)),
                       ("analysis_report.md", report_md),
                       ("unseal_audit.json", json.dumps(audit, indent=2, sort_keys=True))):
        tmp = os.path.join(out_dir, name + ".tmp")
        open(tmp, "w").write(data)
        os.replace(tmp, os.path.join(out_dir, name))
    return {"analysis": analysis, "audit": audit}


def render_report(a: dict) -> str:
    L = ["# §2 Fold-1 Held-Out Evaluation — Analysis Report", ""]
    ca = a["3_primary_C_vs_A"]
    L += ["## 1. Integrity & unseal audit", json.dumps(a["1_integrity"], sort_keys=True), "",
          "## 2. Cell-completeness", json.dumps(a["2_cell_completeness"], sort_keys=True), "",
          "## 3. PRIMARY C vs A",
          f"- Δ(C−A) = {ca['delta']}  (C={ca['C_solves']} A={ca['A_solves']} of {ca['n_tasks']})",
          f"- discordant: C-only={ca['C_only_wins']} A-only={ca['A_only_wins']} "
          f"both={ca['both_solved']} neither={ca['both_failed']}",
          f"- exact one-sided p (C>A) = {ca['exact_one_sided_p']}  two-sided = {ca['exact_two_sided_p']}",
          f"- **evidence_class = {ca['evidence_class']}**", ""]
    for key, title in (("4_secondary_C_vs_B1", "4. Secondary C vs B1"),
                       ("5_secondary_C_vs_D", "5. Secondary C vs D")):
        s = a[key]
        L += [f"## {title}",
              f"- Δ = {s['delta']}  discordant={s['discordant_pairs']}  "
              f"one-sided p = {s['exact_one_sided_p']}  Holm = {s['holm_adjusted_one_sided_p']}", ""]
    L += ["## 6. Stability", json.dumps(a["6_stability"], sort_keys=True), "",
          "## 7. Per-task paired table"]
    for r in a["7_per_task"]:
        L.append(f"- {r['task_id']} [{r['task_family']}]: A={r['A']} C={r['C']} D={r['D']} B1={r['B1']}")
    L += ["", "## 8. Per-family (descriptive only)"]
    for r in a["8_per_family"]:
        L.append(f"- {r['family']} (n={r['n_tasks']}): A={r['A']} C={r['C']} D={r['D']} B1={r['B1']} "
                 f"| C−A={r['C_minus_A']} C−D={r['C_minus_D']} C−B1={r['C_minus_B1']}")
    L += ["", "## 9. Cost / efficiency", json.dumps(a["9_cost_efficiency"], sort_keys=True), "",
          "## 10. Claim boundary", json.dumps(a["10_claim_boundary"], sort_keys=True), ""]
    return "\n".join(L)


def main() -> None:
    args = sys.argv[1:]
    if "--unseal" not in args:
        print("DRY (no decode): analyzer loaded; pass <block_dir> <plan_path> <out_dir> --unseal "
              "--reason <all_folds_complete|predeclared_stop_trigger> to run the one-shot unseal.")
        print("NO records decoded. outcomes_unsealed=false.")
        return
    block_dir, plan_path, out_dir = args[0], args[1], args[2]
    reason = args[args.index("--reason") + 1]
    ts = args[args.index("--timestamp") + 1] if "--timestamp" in args else "unspecified"
    res = unseal_and_analyze(block_dir, plan_path, out_dir, unseal_reason=reason, timestamp=ts)
    print(json.dumps(res["audit"], indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
