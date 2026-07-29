"""§2 Fold-1 unseal analyzer — SYNTHETIC-only tests (no real sealed artifact is ever touched).

Covers: 48/48 completeness required; duplicate/missing/wrong-manifest/unknown-outcome rejected;
wrong-artifact-hash rejected; task-level pairing; stability reps NOT counted as independent
tasks; primary + secondary contrasts fixed; exact McNemar/sign + Holm; deterministic identical
output; and no decode during a dry (non-unseal) invocation.
"""
from __future__ import annotations

import importlib.util
import json
import os

import pytest

_TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
_spec = importlib.util.spec_from_file_location(
    "s2_fold1_unseal_analyze", os.path.join(_TOOLS, "s2_fold1_unseal_analyze.py"))
AZ = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(AZ)

TASKS = {f"t{i}": ("whitespace" if i < 4 else "iterator") for i in range(8)}


def _cells(primary: dict, rep1: dict, *, cost=0.03, calls=1, r2=0):
    """primary[task] = {A,C,D,B1} solves(0/1); rep1[task] = {A,C} solves. Builds 48 cells."""
    cells = []
    for t, fam in TASKS.items():
        for cond in ["A", "C", "D", "B1"]:
            cells.append({"task_id": t, "condition": cond, "rep": 0, "task_family": fam,
                          "solved": primary[t][cond], "ambiguous": False,
                          "cost_usd": cost, "calls": calls, "r2": r2})
        for cond in ["A", "C"]:
            cells.append({"task_id": t, "condition": cond, "rep": 1, "task_family": fam,
                          "solved": rep1[t][cond], "ambiguous": False,
                          "cost_usd": cost, "calls": calls, "r2": r2})
    return cells


def _c_beats_a(b, c):
    """b tasks C-only win, c tasks A-only win, rest both-failed. rep1 mirrors primary."""
    prim, rep = {}, {}
    for i, t in enumerate(TASKS):
        if i < b:
            cs, as_ = 1, 0
        elif i < b + c:
            cs, as_ = 0, 1
        else:
            cs, as_ = 0, 0
        prim[t] = {"A": as_, "C": cs, "D": 0, "B1": 0}
        rep[t] = {"A": as_, "C": cs}
    return prim, rep


# ---- exact stats -------------------------------------------------------------------------------

def test_exact_mcnemar_known_values():
    assert AZ.exact_binom_one_sided_ge(5, 0) == pytest.approx(0.03125)      # 0.5**5
    assert AZ.exact_binom_two_sided(5, 0) == pytest.approx(0.0625)
    assert AZ.exact_binom_one_sided_ge(0, 0) == 1.0
    assert AZ.exact_binom_one_sided_ge(3, 3) == pytest.approx(0.65625)


def test_holm_monotone_and_capped():
    adj = AZ.holm({"a": 0.01, "b": 0.04})
    assert adj["a"] == pytest.approx(0.02) and adj["b"] == pytest.approx(0.04)
    assert all(v <= 1.0 for v in AZ.holm({"a": 0.9, "b": 0.9}).values())


def test_classification_thresholds():
    assert AZ.classify_primary(0.625, 0.03125) == "POSITIVE_STATISTICAL_EVIDENCE"
    assert AZ.classify_primary(0.25, 0.2) == "DIRECTIONAL_POSITIVE_ONLY"
    assert AZ.classify_primary(0.0, 1.0) == "NO_POSITIVE_EFFECT"
    assert AZ.classify_primary(-0.1, 1.0) == "NEGATIVE_DIRECTION"


# ---- completeness ------------------------------------------------------------------------------

def test_full_completeness_required_and_pairing():
    prim, rep = _c_beats_a(5, 0)
    AZ.validate_completeness(_cells(prim, rep), TASKS)          # no raise


def test_missing_cell_rejected():
    prim, rep = _c_beats_a(5, 0)
    cells = _cells(prim, rep)[:-1]
    with pytest.raises(AZ.AnalysisError):
        AZ.validate_completeness(cells, TASKS)


def test_duplicate_cell_rejected():
    prim, rep = _c_beats_a(5, 0)
    cells = _cells(prim, rep)
    cells[-1] = dict(cells[0])                                  # duplicate of (t0,A,0)
    with pytest.raises(AZ.AnalysisError):
        AZ.validate_completeness(cells, TASKS)


def test_wrong_manifest_task_set_rejected():
    prim, rep = _c_beats_a(5, 0)
    with pytest.raises(AZ.AnalysisError):
        AZ.validate_completeness(_cells(prim, rep), {**TASKS, "tX": "boundary"})


def test_unknown_outcome_rejected():
    prim, rep = _c_beats_a(5, 0)
    cells = _cells(prim, rep)
    cells[0]["solved"] = 2
    with pytest.raises(AZ.AnalysisError):
        AZ.validate_completeness(cells, TASKS)


def test_ambiguous_cell_rejected():
    prim, rep = _c_beats_a(5, 0)
    cells = _cells(prim, rep)
    cells[0]["ambiguous"] = True
    with pytest.raises(AZ.AnalysisError):
        AZ.validate_completeness(cells, TASKS)


# ---- analysis ----------------------------------------------------------------------------------

def test_primary_contrast_and_evidence_class():
    prim, rep = _c_beats_a(5, 0)
    a = AZ.analyze(_cells(prim, rep), TASKS)
    ca = a["3_primary_C_vs_A"]
    assert ca["C_solves"] == 5 and ca["A_solves"] == 0
    assert ca["delta"] == pytest.approx(0.625)
    assert ca["C_only_wins"] == 5 and ca["A_only_wins"] == 0
    assert ca["exact_one_sided_p"] == pytest.approx(0.03125)
    assert a["3_primary_C_vs_A"]["evidence_class"] == "POSITIVE_STATISTICAL_EVIDENCE"


def test_unit_count_is_8_not_16_despite_stability():
    prim, rep = _c_beats_a(5, 0)
    a = AZ.analyze(_cells(prim, rep), TASKS)
    assert a["1_integrity"]["unit_level_task_count"] == 8
    assert a["2_cell_completeness"]["primary_cells"] == 32
    assert a["2_cell_completeness"]["stability_cells"] == 16
    assert a["3_primary_C_vs_A"]["n_tasks"] == 8       # inference over 8, not 16


def test_secondary_contrasts_present_with_holm():
    prim, rep = _c_beats_a(5, 0)
    a = AZ.analyze(_cells(prim, rep), TASKS)
    assert a["4_secondary_C_vs_B1"]["x"] == "C" and a["4_secondary_C_vs_B1"]["y"] == "B1"
    assert a["5_secondary_C_vs_D"]["x"] == "C" and a["5_secondary_C_vs_D"]["y"] == "D"
    assert "holm_adjusted_one_sided_p" in a["4_secondary_C_vs_B1"]
    assert "holm_adjusted_one_sided_p" in a["5_secondary_C_vs_D"]


def test_stability_agreement_and_sensitivity():
    prim, rep = _c_beats_a(5, 0)                          # rep mirrors primary → agreement 1.0
    a = AZ.analyze(_cells(prim, rep), TASKS)
    assert a["6_stability"]["A"]["agreement_rate"] == 1.0
    assert a["6_stability"]["C"]["agreement_rate"] == 1.0
    assert a["6_stability"]["delta_rep_C_minus_A"] == pytest.approx(0.625)


def test_cost_table_handles_zero_solved():
    prim, rep = _c_beats_a(0, 0)                          # nobody solves
    a = AZ.analyze(_cells(prim, rep), TASKS)
    assert a["9_cost_efficiency"]["A"]["cost_per_solved_usd"] == "undefined"


def test_deterministic_identical_output():
    prim, rep = _c_beats_a(4, 1)
    j1 = json.dumps(AZ.analyze(_cells(prim, rep), TASKS), sort_keys=True)
    j2 = json.dumps(AZ.analyze(_cells(prim, rep), TASKS), sort_keys=True)
    assert j1 == j2


# ---- guarded unseal path -----------------------------------------------------------------------

def test_unseal_rejects_undeclared_reason(tmp_path):
    with pytest.raises(AZ.AnalysisError):
        AZ.unseal_and_analyze(str(tmp_path), str(tmp_path / "plan.md"), str(tmp_path / "out"),
                              unseal_reason="curiosity", timestamp="t")


def test_unseal_rejects_wrong_artifact_hash(tmp_path):
    (tmp_path / "sealed_outcomes.jsonl").write_text("not the real sealed artifact\n")
    (tmp_path / "plan.md").write_text("plan")
    with pytest.raises(AZ.AnalysisError):
        AZ.unseal_and_analyze(str(tmp_path), str(tmp_path / "plan.md"), str(tmp_path / "out"),
                              unseal_reason="all_folds_complete", timestamp="t")


def test_records_to_cells_maps_hidden_verdict():
    manifest = {"heldout_tasks": TASKS}
    recs = [{"task_id": "t0", "condition": "C", "rep": 0,
             "report": {"hidden_verdict": True, "round2_opened": False, "calls_sent": 1,
                        "per_call": [{"actual_cost_usd": "0.03"}]}},
            {"task_id": "t0", "condition": "A", "rep": 0,
             "report": {"hidden_verdict": None, "round2_opened": True, "calls_sent": 2,
                        "per_call": [{"actual_cost_usd": "0.02"}, {"actual_cost_usd": "0.02"}]}}]
    cells = AZ.records_to_cells(recs, manifest)
    assert cells[0]["solved"] == 1 and cells[1]["solved"] == 0     # None → FAILED
    assert cells[1]["r2"] == 1 and cells[1]["calls"] == 2
    assert cells[0]["cost_usd"] == pytest.approx(0.03)


def test_dry_run_decodes_nothing(capsys, monkeypatch):
    monkeypatch.setattr(AZ.sys, "argv", ["analyzer", "block", "plan"])   # no --unseal
    AZ.main()
    out = capsys.readouterr().out
    assert "NO records decoded" in out and "outcomes_unsealed=false" in out
