"""V3 Gate-A unseal analyzer — SYNTHETIC-only tests (no real sealed artifact touched). Covers
PASS/BORDERLINE/FAIL fixtures, completeness rejections, unknown outcome, threshold boundaries,
deterministic output, and a dry-run that decodes nothing.
"""
from __future__ import annotations

import importlib.util
import json
import os

import pytest

_TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
_spec = importlib.util.spec_from_file_location(
    "v3_gate_a_unseal_analyze", os.path.join(_TOOLS, "v3_gate_a_unseal_analyze.py"))
AZ = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(AZ)

TASKS = [f"t{i}" for i in range(9)]
V = AZ.VALID_STATE
MAL = "NEW_MALFORMED"


def _cells(old_valid, new_valid, *, old_state=None, new_state=None):
    """old_valid/new_valid: lists of 0/1 length 9."""
    cells = []
    for i, t in enumerate(TASKS):
        cells.append({"task_id": t, "contract": "OLD", "valid_applied": old_valid[i],
                      "terminal_state": (V if old_valid[i] else MAL) if old_state is None else old_state[i],
                      "silent_partial": 0, "ambiguous_accepted": 0, "replay_fail": 0,
                      "hidden": 0, "public": "PASS"})
        cells.append({"task_id": t, "contract": "NEW", "valid_applied": new_valid[i],
                      "terminal_state": (V if new_valid[i] else MAL) if new_state is None else new_state[i],
                      "silent_partial": 0, "ambiguous_accepted": 0, "replay_fail": 0,
                      "hidden": 0, "public": "PASS"})
    return cells


def test_pass_fixture():
    # OLD 5/9, NEW 9/9 → NEW=9>=8, NEW-OLD=4>=3 → PASS
    a = AZ.analyze(_cells([1, 1, 1, 1, 1, 0, 0, 0, 0], [1] * 9))
    assert a["2_summary"]["NEW_valid_applied"] == 9 and a["2_summary"]["NEW_minus_OLD"] == 4
    assert a["3_classification"] == "PASS"


def test_borderline_seven():
    # NEW 7/9 → BORDERLINE regardless of diff
    a = AZ.analyze(_cells([0] * 9, [1, 1, 1, 1, 1, 1, 1, 0, 0]))
    assert a["2_summary"]["NEW_valid_applied"] == 7 and a["3_classification"] == "BORDERLINE"


def test_borderline_eight_small_improvement():
    # NEW 8/9, OLD 7/9 → diff=1 → BORDERLINE
    a = AZ.analyze(_cells([1, 1, 1, 1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1, 0]))
    assert a["2_summary"]["NEW_valid_applied"] == 8 and a["2_summary"]["NEW_minus_OLD"] == 1
    assert a["3_classification"] == "BORDERLINE"


def test_fail_low_valid():
    a = AZ.analyze(_cells([0] * 9, [1, 1, 1, 1, 1, 1, 0, 0, 0]))       # NEW 6/9
    assert a["3_classification"] == "FAIL"


def test_fail_no_improvement():
    # NEW 9/9 but OLD 9/9 → diff 0 → FAIL
    a = AZ.analyze(_cells([1] * 9, [1] * 9))
    assert a["2_summary"]["NEW_minus_OLD"] == 0 and a["3_classification"] == "FAIL"


def test_hard_fail_ambiguous_forces_fail():
    cells = _cells([0] * 9, [1] * 9)
    cells[1]["ambiguous_accepted"] = 1                                 # one accepted ambiguous
    a = AZ.analyze(cells)
    assert a["2_summary"]["ambiguous_accepted"] == 1 and a["3_classification"] == "FAIL"


def test_boundary_pass_exactly_8_and_3():
    # NEW 8/9, OLD 5/9 → diff=3 → PASS
    a = AZ.analyze(_cells([1, 1, 1, 1, 1, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1, 0]))
    assert a["2_summary"]["NEW_valid_applied"] == 8 and a["2_summary"]["NEW_minus_OLD"] == 3
    assert a["3_classification"] == "PASS"


def test_missing_cell_rejected():
    cells = _cells([0] * 9, [1] * 9)[:-1]
    with pytest.raises(AZ.AnalysisError):
        AZ.analyze(cells)


def test_duplicate_cell_rejected():
    cells = _cells([0] * 9, [1] * 9)
    cells[-1] = dict(cells[0])
    with pytest.raises(AZ.AnalysisError):
        AZ.analyze(cells)


def test_unknown_outcome_rejected():
    with pytest.raises(AZ.AnalysisError):
        AZ.cell_metrics({"task_id": "t0", "contract": "NEW", "valid_applied_patch": False,
                         "terminal_state": "WAT_UNKNOWN"})


def test_valid_with_nonvalid_state_rejected():
    with pytest.raises(AZ.AnalysisError):
        AZ.cell_metrics({"task_id": "t0", "contract": "NEW", "valid_applied_patch": True,
                         "terminal_state": "NEW_AMBIGUOUS"})


def test_cell_metrics_maps_valid_and_hidden():
    m = AZ.cell_metrics({"task_id": "t0", "contract": "NEW", "valid_applied_patch": True,
                         "terminal_state": V, "hidden_verdict": True, "public_status": "PASS"})
    assert m["valid_applied"] == 1 and m["hidden"] == 1 and m["ambiguous_accepted"] == 0


def test_deterministic_identical_output():
    c = _cells([1, 0, 1, 0, 1, 0, 1, 0, 1], [1, 1, 1, 1, 1, 1, 1, 1, 0])
    assert json.dumps(AZ.analyze(c), sort_keys=True) == json.dumps(AZ.analyze(c), sort_keys=True)


def test_unseal_rejects_undeclared_reason(tmp_path):
    with pytest.raises(AZ.AnalysisError):
        AZ.unseal_and_analyze(str(tmp_path), str(tmp_path / "p.md"), str(tmp_path / "o"),
                              unseal_reason="peek", timestamp="t")


def test_unseal_rejects_wrong_artifact_hash(tmp_path):
    (tmp_path / "sealed_outcomes.jsonl").write_text("not the real artifact\n")
    (tmp_path / "p.md").write_text("plan")
    with pytest.raises(AZ.AnalysisError):
        AZ.unseal_and_analyze(str(tmp_path), str(tmp_path / "p.md"), str(tmp_path / "o"),
                              unseal_reason="gate_a_complete", timestamp="t")


def test_dry_run_decodes_nothing(capsys, monkeypatch):
    monkeypatch.setattr(AZ.sys, "argv", ["az", "b", "p"])
    AZ.main()
    out = capsys.readouterr().out
    assert "NO records decoded" in out and "outcomes_unsealed=false" in out
