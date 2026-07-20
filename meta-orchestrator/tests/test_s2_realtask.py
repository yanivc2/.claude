"""Repo-backed real-task adapter — isolation + logic, offline (node execution monkeypatched, $0).

Proves the guarantees that let us keep the frozen architecture instead of an opaque-handle rewrite:
the solver only ever sees source + sanitised public feedback; the mixed test file / hidden node id /
hidden content never reach the RoundView, the prompt or the R2 feedback; a patch can't touch a test
file; Round 2 opens only on a genuine public FAIL; the hidden verdict is computed last, never fed back.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.s2 import realtask as R

F2P = [["tests/test_black.py", "comments2"]]
ALLOWED = ["blib2to3/pgen2/driver.py", "blib2to3/pgen2/tokenize.py"]
# the mixed test file content the solver must NEVER see (both P2P and F2P live here):
MIXED_TEST_FILE = "def test_comments2():\n    assert black.format_str(SRC) == EXPECTED  # hidden F2P\n"


def _ctx(tmp_path, **over):
    repo = tmp_path / "repo"
    (repo / "blib2to3" / "pgen2").mkdir(parents=True, exist_ok=True)
    for p in ALLOWED:
        (repo / p).write_text("def driver():\n    return 0\n")
    base = dict(task_id="black-112", repo=str(repo), py="python", allowed_source_files=ALLOWED,
                p2p_nodes=[f"tests/test_black.py::t{i}" for i in range(24)], f2p_plan=F2P,
                buggy_source={p: "def driver():\n    return 0\n" for p in ALLOWED},
                network_isolated=True)
    base.update(over)
    return R.RealTaskContext(**base)


def test_netns_prefix_is_a_real_boundary_flag():
    assert R.NETNS_PREFIX == ["unshare", "-rn"]              # OS network namespace, not a code assertion


def test_patch_cannot_touch_a_test_file(tmp_path):
    ctx = _ctx(tmp_path)
    with pytest.raises(ValueError):
        R.apply_patch(ctx, {"tests/test_black.py": [("x", "y")]})   # not in allowed_source_files
    R.apply_patch(ctx, {ALLOWED[0]: [("    return 0", "    return 1")]})   # allowed → ok
    assert (tmp_path / "repo" / ALLOWED[0]).read_text() == "def driver():\n    return 1\n"


def test_sanitize_caps_and_drops_raw_paths():
    raw = "/abs/secret/path/tests/test_black.py::comments2 FAILED\n" + ("x" * 5000)
    s = R._sanitize(raw)
    assert len(s) <= R.PUBLIC_FEEDBACK_CAP
    assert "/abs/secret/path/" not in s


def test_public_status_mapping(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    monkeypatch.setattr(R, "_pytest_nodes",
                        lambda c, nodes: ({n: "PASSED" for n in nodes}, False, "ok"))
    assert R.run_public_tests(ctx).status == "PASS"
    monkeypatch.setattr(R, "_pytest_nodes",
                        lambda c, nodes: ({nodes[0]: "FAILED"}, False, "FAILED node"))
    assert R.run_public_tests(ctx).status == "FAIL"
    monkeypatch.setattr(R, "_pytest_nodes", lambda c, nodes: ({}, False, "boom"))
    assert R.run_public_tests(ctx).status == "INFRA_ERROR"
    assert R.run_public_tests(_ctx(tmp_path, p2p_nodes=[])).status == "NO_PUBLIC_TESTS"


_F2P_NODE = "tests/test_black.py::BlackTestCase::test_comments2"


def test_hidden_verify_guards_selector_and_returns_bool_only(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    monkeypatch.setattr(R, "collect_hidden_nodes", lambda c: [_F2P_NODE])   # exactly one node
    monkeypatch.setattr(R, "_pytest", lambda c, args: ({args[0]: "PASSED"}, False, "tb: secret"))
    assert R.hidden_verify(ctx) is True                      # bool only; no traceback leaks
    monkeypatch.setattr(R, "_pytest", lambda c, args: ({args[0]: "FAILED"}, False, "x"))
    assert R.hidden_verify(ctx) is False


def test_hidden_selector_matching_not_exactly_one_is_config_failure(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path)
    monkeypatch.setattr(R, "collect_hidden_nodes", lambda c: [_F2P_NODE, "tests/test_black.py::x"])
    with pytest.raises(R.GateError):                         # 2 matches → config failure, not FAIL
        R.hidden_verify(ctx)
    monkeypatch.setattr(R, "collect_hidden_nodes", lambda c: [])            # 0 matches
    with pytest.raises(R.GateError):
        R.hidden_verify(ctx)


def test_hidden_selection_overlap_with_p2p_is_blocked(tmp_path, monkeypatch):
    ctx = _ctx(tmp_path, p2p_nodes=[_F2P_NODE, "tests/test_black.py::t1"])   # F2P also in P2P
    monkeypatch.setattr(R, "collect_hidden_nodes", lambda c: [_F2P_NODE])
    with pytest.raises(R.GateError):
        R.assert_hidden_selection_valid(ctx)


def _dry(tmp_path, monkeypatch, *, pub_seq, verdict):
    ctx = _ctx(tmp_path)
    calls = {"i": 0}
    def fake_pub(c):
        st = pub_seq[min(calls["i"], len(pub_seq) - 1)]; calls["i"] += 1
        return R.PublicResult(status=st, passed=(st == "PASS"), tests_run=24,
                              sanitized_summary="" if st == "PASS" else "test_x FAILED: assert 1==2")
    monkeypatch.setattr(R, "run_public_tests", fake_pub)
    monkeypatch.setattr(R, "hidden_verify", lambda c: verdict)
    # frozen SEARCH/REPLACE fix (LESSON-first for is_train, mandatory ### END)
    fix = ('### LESSON\n{"recommended_action": ["return the corrected value"], "avoid": ["edits to tests"]}\n'
           "### PATCH\n### FILE: %s\n<<<<<<< SEARCH\n    return 0\n=======\n    return 1\n"
           ">>>>>>> REPLACE\n### END" % ALLOWED[0])
    return ctx, fix


def test_dry_run_isolation_r1_fail_then_r2(tmp_path, monkeypatch):
    ctx, fix = _dry(tmp_path, monkeypatch, pub_seq=["FAIL", "PASS"], verdict=True)
    rep = R.dry_run_attempt(ctx, statement="Fix the whitespace bug.", memory_lines=[],
                            r1_text=fix, r2_text=fix, is_train=True,
                            mixed_test_file_marker="hidden F2P")
    assert rep.round2_opened is True and rep.rounds == 2       # R2 opened on a genuine public FAIL
    assert rep.public_statuses == ["FAIL", "PASS"]
    assert rep.hidden_verdict is True                          # verifier ran last
    # ISOLATION: the mixed test file content never reached the R1 prompt, and the R2 feedback
    # carries no hidden node id / F2P keyword.
    assert rep.r1_prompt_has_test_file_content is False
    assert rep.r2_feedback_has_hidden_nodeid is False
    assert "comments2" not in rep.r1_prompt and "comments2" not in (rep.r2_feedback or "")
    assert MIXED_TEST_FILE not in rep.r1_prompt


def test_dry_run_r1_terminal_success_opens_no_r2(tmp_path, monkeypatch):
    ctx, fix = _dry(tmp_path, monkeypatch, pub_seq=["PASS"], verdict=True)
    rep = R.dry_run_attempt(ctx, statement="Fix it.", memory_lines=[], r1_text=fix, r2_text=fix,
                            is_train=True)
    assert rep.round2_opened is False and rep.rounds == 1      # public PASS → no R2
    assert rep.public_statuses == ["PASS"]
