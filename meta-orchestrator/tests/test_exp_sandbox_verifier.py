"""Pilot-0: sandbox reset + composite verifier gates."""
from __future__ import annotations

from meta_orchestrator.experiment.fixtures import OFF_BY_ONE
from meta_orchestrator.experiment.sandbox import Sandbox
from meta_orchestrator.experiment.verifier import VERIFIER_VERSION, verify, verifier_config_hash


def test_sandbox_resets_between_runs():
    with Sandbox(OFF_BY_ONE) as sb:
        sb.write("solution.py", "def sum_to(n):\n    return 0\n")
        assert sb.read("solution.py") == "def sum_to(n):\n    return 0\n"
    # a fresh sandbox has the original buggy source — no leakage
    with Sandbox(OFF_BY_ONE) as sb2:
        assert sb2.read("solution.py") == OFF_BY_ONE.source["solution.py"]


def test_reference_fix_passes_all_gates():
    with Sandbox(OFF_BY_ONE) as sb:
        sb.write("solution.py", OFF_BY_ONE.reference_fix["solution.py"])
        v = verify(OFF_BY_ONE, sb)
    assert v.passed is True
    assert all(v.gates.values())
    assert v.failing_gate is None


def test_unfixed_source_fails_tests():
    with Sandbox(OFF_BY_ONE) as sb:
        v = verify(OFF_BY_ONE, sb)  # no change
    assert v.passed is False
    # buggy sum_to already fails the PUBLIC suite here (sum_to(5)=10≠15)
    assert v.gates["public_tests"] is False


def test_hardcoded_answer_fails_shortcut_and_hidden():
    with Sandbox(OFF_BY_ONE) as sb:
        sb.write("solution.py", "def sum_to(n):\n    return 15\n")
        v = verify(OFF_BY_ONE, sb)
    assert v.passed is False
    assert v.gates["public_tests"] is True          # public answer is 15
    assert v.gates["hidden_tests"] is False          # hidden probes 3→6, 1→1
    assert v.gates["no_forbidden_shortcuts"] is False
    assert v.failing_gate == "no_forbidden_shortcuts"  # caught before tests in gate order


def test_tampering_with_tests_fails_protected_gate():
    with Sandbox(OFF_BY_ONE) as sb:
        # simulate a raw tamper (the tool layer blocks this; here we prove the gate catches it)
        sb.write("tests_hidden/test_hidden.py", "def test_ok():\n    assert True\n")
        sb.write("solution.py", OFF_BY_ONE.reference_fix["solution.py"])
        v = verify(OFF_BY_ONE, sb)
    assert v.gates["protected_test_dir_unchanged"] is False
    assert v.passed is False


def test_verdict_carries_version_and_config_hash():
    """v2 §5: every verdict is stamped with the frozen verifier's version + config hash."""
    with Sandbox(OFF_BY_ONE) as sb:
        sb.write("solution.py", OFF_BY_ONE.reference_fix["solution.py"])
        v = verify(OFF_BY_ONE, sb)
    assert v.verifier_version == VERIFIER_VERSION == "6gate-v1"
    assert v.verifier_config_hash == verifier_config_hash()
    assert len(v.verifier_config_hash) == 12          # short content hash, stable per logic
    assert v.verifier_config_hash.isalnum()


def test_out_of_scope_patch_fails_scope_gate():
    task = OFF_BY_ONE.model_copy(update={"max_changed_files": 0})
    with Sandbox(task) as sb:
        sb.write("solution.py", task.reference_fix["solution.py"])
        v = verify(task, sb)
    assert v.gates["patch_within_scope"] is False
    assert v.passed is False
