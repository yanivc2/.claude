"""Offline unit tests for the repo-backed reproduction PURE helpers (no network, no model)."""
from __future__ import annotations

from meta_orchestrator.experiment.s2.repro import (RepoBackedTask, ReproStatus,
                                                   statement_leak_scan)


def test_leak_scan_flags_hidden_test_name():
    hits = statement_leak_scan("the crash happens in test_fmtonoff cases", ["tests/t.py::test_fmtonoff"],
                               "deadbeef1234", ["src/black/linegen.py"])
    assert any("hidden-test" in h for h in hits)


def test_leak_scan_flags_fix_commit_and_path():
    assert any("fix commit" in h for h in
               statement_leak_scan("see deadbeef", [], "deadbeef1234", []))
    assert any("allowed-file" in h for h in
               statement_leak_scan("edit linegen.py now", [], "x", ["src/black/linegen.py"]))


def test_leak_scan_flags_patch_hint():
    assert any("patch hint" in h for h in
               statement_leak_scan("the root cause is X", [], "x", []))
    assert statement_leak_scan("Cannot parse input at the top level", [], "abc00000", []) == []


def test_status_codes_are_distinct():
    codes = {ReproStatus.REPRODUCED_PUBLIC_NONEMPTY, ReproStatus.REPRODUCED_PUBLIC_EMPTY,
             ReproStatus.NON_REPRODUCIBLE, ReproStatus.HARNESS_DEPENDENCY_FAILURE,
             ReproStatus.INVALID_F2P, ReproStatus.INVALID_P2P, ReproStatus.LEAKAGE_REJECTED}
    assert len(codes) == 7
    # both "reproduced" statuses count as reproduced (public suite is optional — decision A)
    assert ReproStatus.REPRODUCED == {ReproStatus.REPRODUCED_PUBLIC_NONEMPTY,
                                      ReproStatus.REPRODUCED_PUBLIC_EMPTY}


def test_public_empty_task_is_valid():
    t = RepoBackedTask(task_id="black-95", project="black", family="iterator", repo_url="u",
                       buggy_rev="a", fixed_rev="b", allowed_source_files=["src/black/x.py"],
                       repair_scope="single_file", buggy_source={"src/black/x.py": "bug"},
                       reference_fix={"src/black/x.py": "fix"}, f2p_plan=[["tests/t.py", "k"]],
                       p2p_nodes=[], public_suite_empty=True, sanitized_statement="a general one")
    assert t.public_suite_empty is True and t.p2p_nodes == []


def test_repo_backed_task_roundtrips():
    t = RepoBackedTask(task_id="black-1", project="black", family="whitespace",
                       repo_url="u", buggy_rev="a", fixed_rev="b",
                       allowed_source_files=["src/black/x.py"], repair_scope="single_file",
                       buggy_source={"src/black/x.py": "bug"}, reference_fix={"src/black/x.py": "fix"},
                       f2p_plan=[["tests/t.py", None]], p2p_nodes=["tests/t.py::test_ok"],
                       sanitized_statement="general statement here")
    assert RepoBackedTask.model_validate_json(t.model_dump_json()).fixed_rev == "b"
