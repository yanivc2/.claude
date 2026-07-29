"""§2 Fold-1 EXPLORATORY post-hoc diagnostic ($0, read-only) — mechanical tables only.

Reads the (already-unsealed) sealed records + the frozen bank + the frozen analysis, and emits
the MECHANICAL diagnostic tables: per-cell failure mode, per-task condition pairing, per-lesson
injection map, and the apparatus-vs-arena signal counts. It changes NO official result, reruns
NO cell, reclassifies NO outcome, and mutates NO bank. Semantic classifications (lesson
relevance / quality) are recorded by hand in S2_FOLD1_POSTHOC_DIAGNOSTIC_FINDINGS.md; this
script only computes the reproducible counts those judgements sit on.

Usage: python tools/s2_fold1_posthoc_diagnostic.py   (writes corpus/s2_fold1_eval/analysis/diagnostic.json)
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "src"))
CORPUS = os.path.join(HERE, "corpus")
BD = os.path.join(CORPUS, "s2_fold1_eval")

from meta_orchestrator.experiment.s2.heldout_eval import (SealedOutcomeStore,
                                                          UNSEAL_ALL_FOLDS_COMPLETE)
from meta_orchestrator.experiment.s2.memory import load_frozen_fold_bank, resolve_memory

PRIMARY = ["A", "C", "D", "B1"]


def _failure_mode(rep: dict) -> str:
    """Reduce a cell report to a single mechanical failure/success mode."""
    if rep.get("hidden_verdict") is True:
        return "SOLVED_hidden_pass"
    if rep.get("patch_applied"):                 # valid patch applied but hidden failed
        return "VALID_PATCH_hidden_fail"
    ps = rep.get("public_statuses") or []
    if any("PATCH_APPLY" in s for s in ps):
        return "PATCH_APPLY_FAIL"
    if any("MALFORMED" in s for s in ps):
        return "MALFORMED_OUTPUT"
    if any("TRUNCAT" in s for s in ps):
        return "TRUNCATED_OUTPUT"
    return "OTHER_SOLVER_FAIL"


def main() -> None:
    bank = load_frozen_fold_bank(CORPUS)
    man = json.load(open(os.path.join(BD, "eval_manifest.json")))
    held = man["heldout_tasks"]
    st = SealedOutcomeStore(os.path.join(BD, "sealed_outcomes.jsonl"))
    recs = st.outcome_table(unseal_reason=UNSEAL_ALL_FOLDS_COMPLETE)
    by = {(r["task_id"], r["condition"], r["rep"]): r["report"] for r in recs}
    tasks = sorted(held)

    per_task, mode_counts = [], {}
    valid_patch = solved = 0
    for t in tasks:
        fam = held[t]
        inj = resolve_memory("C", fam, bank=bank).lesson_ids or []
        row = {"task_id": t, "family": fam, "C_injected_lessons": inj,
               "C_empty_slot": not inj, "cells": {}}
        outs = {}
        for c in PRIMARY:
            rep = by[(t, c, 0)]
            mode = _failure_mode(rep)
            mode_counts[mode] = mode_counts.get(mode, 0) + 1
            s = 1 if rep.get("hidden_verdict") is True else 0
            outs[c] = s
            if rep.get("patch_applied"):
                valid_patch += 1
            solved += s
            row["cells"][c] = {"solved": s, "mode": mode,
                               "round2": bool(rep.get("round2_opened"))}
        a, cc = outs["A"], outs["C"]
        row["C_vs_A_pairing"] = ("C_ONLY_WIN" if cc and not a else
                                 "A_ONLY_WIN" if a and not cc else
                                 "BOTH_SOLVED" if a and cc else "BOTH_FAILED")
        per_task.append(row)

    # discordant C-vs-A with memory attribution
    discordant = []
    for row in per_task:
        if row["C_vs_A_pairing"] in ("C_ONLY_WIN", "A_ONLY_WIN"):
            discordant.append({"task_id": row["task_id"], "family": row["family"],
                               "pairing": row["C_vs_A_pairing"],
                               "C_had_memory": not row["C_empty_slot"],
                               "C_injected": row["C_injected_lessons"],
                               "C_mode": row["cells"]["C"]["mode"],
                               "A_mode": row["cells"]["A"]["mode"]})

    n_primary = len(tasks) * len(PRIMARY)
    diag = {
        "analysis_type": "EXPLORATORY_POSTHOC",
        "official_primary_result": "unchanged (Δ(C−A)=-0.25, NEGATIVE_DIRECTION, two-sided p=0.625)",
        "no_cells_rerun": True, "no_outcomes_reclassified": True, "no_exclusions_added": True,
        "no_bank_changes": True,
        "apparatus_signal": {
            "primary_cells": n_primary,
            "valid_applied_patch_cells": valid_patch,
            "no_valid_patch_cells": n_primary - valid_patch,
            "no_valid_patch_rate": round((n_primary - valid_patch) / n_primary, 4),
            "hidden_pass_given_valid_patch": (f"{solved}/{valid_patch}"
                                              if valid_patch else "undefined"),
            "failure_mode_counts": dict(sorted(mode_counts.items()))},
        "discordant_C_vs_A": discordant,
        "per_task": per_task,
        "lesson_injection_map": {row["task_id"]: row["C_injected_lessons"] for row in per_task},
    }
    out = os.path.join(BD, "analysis", "diagnostic.json")
    json.dump(diag, open(out, "w"), indent=2, sort_keys=True)
    print(json.dumps(diag["apparatus_signal"], indent=2, sort_keys=True))
    print("\ndiscordant C-vs-A:")
    for d in discordant:
        print(f"  {d['task_id']:<12} {d['pairing']:<12} C_mem={d['C_had_memory']} "
              f"C_mode={d['C_mode']} A_mode={d['A_mode']}")
    print(f"\n→ {out}")


if __name__ == "__main__":
    main()
