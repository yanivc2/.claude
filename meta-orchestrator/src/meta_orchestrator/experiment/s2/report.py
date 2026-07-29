"""Offline harness report (Step-1 deliverable, criterion 9).

Assembles the run summary: invariant checks, hashes, per-fold flow, residual risks, and an
updated cost estimate. Pure data + a text renderer — it makes NO API calls and asserts the
run was mock-only.
"""
from __future__ import annotations

from collections import Counter
from typing import Optional

from .memory import SEMANTIC_FAMILIES, StaticPlaybook


def fixture_playbook() -> StaticPlaybook:
    """A NON-author-frozen fixture playbook for D (real runs are blocked until D is frozen)."""
    return StaticPlaybook(
        by_family={f: ["prefer a minimal targeted edit", "re-run the public suite first"]
                   for f in SEMANTIC_FAMILIES},
        author_frozen=False, author="fixture",
    )


def build_report(harness, fold_runs, stability, gate, checks, *,
                 cost_per_attempt: float = 0.025) -> dict:
    fam_counts = dict(Counter(harness.family_map.values()))
    attempts_pilot = harness.outcomes.cost_signals()["attempts"]
    # Full-run projection: 3 folds × (A9 + B1·9 + D9 + C[18 learn + 9 eval]) at reps=1.
    full_attempts = harness.k * (9 + 9 + 9 + (18 + 9))
    return {
        "step": "1 — offline mock harness (A/C/D/B1)",
        "provider": harness.contract.provider,
        "paid_api_called": False,
        "corpus": {
            "n": len(harness.family_map),
            "synthetic_family_map": harness.synthetic_map,
            "family_counts": fam_counts,
            "family_map_hash": harness.family_map_hash(),
        },
        "folds": [
            {"index": fr.fold, "n_test": fr.n_test,
             "bank_hash": fr.bank_hash, "bank_families": fr.bank_families}
            for fr in fold_runs
        ],
        "hashes": {
            "verifier_config_hash": harness.outcomes.harness_signals()["verifier_config_hash"],
            "contract_snapshot": harness.contract.snapshot()[:16],
            "placebo_map_hash": harness.placebo.map_hash(),
            "playbook_hash": harness.playbook.content_hash(),
            "playbook_author_frozen": harness.playbook.author_frozen,
        },
        "invariants": checks,
        "stability_pilot_fold": stability.model_dump() if stability else None,
        "gate_decision": gate.model_dump() if gate else None,
        "residual_risks": [
            "family map is SYNTHETIC — the $0 primary_sub_fingerprint map must be generated "
            "and frozen before the micro-pilot (real-run guard enforces this).",
            "the static playbook D is a fixture (author_frozen=False) — an independent author "
            "must write and freeze the real D before it runs.",
            "synthetic stand-in tasks exercise plumbing only; real bugs need a cloned repo + "
            "real test run (online, model-free reproduction) to become the actual corpus.",
            "n=27 is a directional pilot; per-fold n=9 has wide CIs (Decision E) — no "
            "confirmatory claim from this run.",
            "LessonSensitiveMock is a routing test-double; it makes no claim a real model "
            "behaves this way (the micro-pilot replaces it).",
        ],
        "cost_estimate": {
            "pilot_fold_attempts_run_offline": attempts_pilot,
            "offline_cost": 0.0,
            "projected_full_run_attempts_reps1": full_attempts,
            "projected_full_run_cost_usd": round(full_attempts * cost_per_attempt, 2),
            "cost_per_attempt_assumed": cost_per_attempt,
            "note": "projection is for the FUTURE real run; this offline step cost $0.",
        },
        "self_checks_passed": all(c["ok"] for c in checks),
    }


def _fold_flow(fold_runs) -> str:
    lines = ["fold flow (each held-out task → A / C / D / B1 → sealed outcome):"]
    for fr in fold_runs:
        lines.append(f"  fold {fr.fold}: learn bank from 18 train "
                     f"[{','.join(fr.bank_families)}] → freeze ({fr.bank_hash}) "
                     f"→ {fr.n_test} held-out × 4 conditions → sealed")
    return "\n".join(lines)


def render_text(report: dict, fold_runs) -> str:
    out: list[str] = []
    out.append("=" * 78)
    out.append(f"§2 STEP-1 OFFLINE HARNESS REPORT — provider={report['provider']} "
               f"paid_api_called={report['paid_api_called']}")
    out.append("=" * 78)
    c = report["corpus"]
    out.append(f"corpus: n={c['n']} synthetic_map={c['synthetic_family_map']} "
               f"family_map_hash={c['family_map_hash']}")
    out.append(f"        family counts: {c['family_counts']}")
    out.append("")
    out.append(_fold_flow(fold_runs))
    out.append("")
    out.append("invariants:")
    for chk in report["invariants"]:
        mark = "PASS" if chk["ok"] else "FAIL"
        out.append(f"  [{mark}] {chk['name']}: {chk['detail']}")
    out.append("")
    h = report["hashes"]
    out.append("hashes / freeze state:")
    for k, v in h.items():
        out.append(f"  {k}: {v}")
    out.append("")
    if report["stability_pilot_fold"]:
        out.append(f"stability (pilot fold): {report['stability_pilot_fold']}")
    if report["gate_decision"]:
        out.append(f"continue/stop gate: {report['gate_decision']}")
    out.append("")
    out.append("residual risks:")
    for r in report["residual_risks"]:
        out.append(f"  - {r}")
    out.append("")
    ce = report["cost_estimate"]
    out.append(f"cost: offline=${ce['offline_cost']} | projected full run (reps=1) = "
               f"{ce['projected_full_run_attempts_reps1']} attempts ≈ "
               f"${ce['projected_full_run_cost_usd']}")
    out.append("")
    out.append(f"SELF-CHECKS {'PASSED ✓' if report['self_checks_passed'] else 'FAILED ✗'} "
               f"— STOP before any real API (micro-pilot is a separate, approved step).")
    out.append("=" * 78)
    return "\n".join(out)
