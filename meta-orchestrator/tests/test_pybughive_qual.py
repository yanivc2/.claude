"""Pure helpers of the PyBugHive project-qualifier (objective, model-free, deterministic)."""
from __future__ import annotations

from meta_orchestrator.corpus.pybughive_qual import (
    CandidateMeta,
    PatchMetrics,
    build_report,
    decide,
    fingerprint,
    is_degenerate,
    is_test_module,
    patch_metrics,
    plan_f2p_selection,
    primary_sub_fingerprint,
    recommend,
    sub_fingerprints,
)


def test_sub_fingerprints_multilabel_from_changed_lines():
    assert "boundary" in sub_fingerprints("@@\n-    x = a[i]\n+    x = a[i - 1]\n")
    assert "condition_inversion" in sub_fingerprints("@@\n-    if ok:\n+    if not ok:\n")
    assert "state_mutation" in sub_fingerprints("@@\n+    items.append(y)\n")
    # only +/- lines are read, not context; empty change → unclassified
    assert sub_fingerprints("@@\n     unchanged_context_line\n") == ["unclassified_logic"]


def test_primary_sub_fingerprint_specificity_order_and_tight_inversion():
    # a bare `==` must NOT be read as an inversion (the old over-firing bug)
    assert primary_sub_fingerprint("@@\n-    if a == b:\n+    if a == c:\n") == "other_logic"
    # a real inversion (added `not`) is condition_inversion...
    assert primary_sub_fingerprint("@@\n-    if ok:\n+    if not ok:\n") == "condition_inversion"
    # ...but a more-specific signal in the same diff wins (iterator > condition)
    assert primary_sub_fingerprint("@@\n-    if not ok:\n+    for x in ok:\n") == "iterator"
    assert primary_sub_fingerprint("@@\n+        self.buf.append(x)\n") == "state_mutation"
    assert primary_sub_fingerprint("@@\n-   blank_lines = 1\n+   blank_lines = 2\n") == "whitespace"


# --- F2P test selection (frozen spec) ---------------------------------------------------
def test_is_test_module():
    assert is_test_module("def test_x():\n    pass") is True
    assert is_test_module("class TestFoo:\n    pass") is True
    assert is_test_module("x = 1  # just a data fixture") is False


def test_plan_direct_test_module():
    idx = {"tests/test_a.py": "def test_a(): pass"}
    plan, log = plan_f2p_selection(["tests/test_a.py"], idx)
    assert plan == [("tests/test_a.py", None)]


def test_plan_fixture_maps_to_consumer_with_keyword():
    # fix adds a data fixture; the real F2P test is a parametrized test that names it
    idx = {
        "tests/test_format.py": "def test_simple_cases(case):\n    # runs fmtskip6\n    assert fmtskip6",
        "tests/test_other.py": "def test_unrelated(): pass",
    }
    plan, log = plan_f2p_selection(["tests/data/fmtskip6.py"], idx)
    assert ("tests/test_format.py", "fmtskip6") in plan          # consumer, filtered by -k token
    assert all(f != "tests/test_other.py" for f, _ in plan)      # non-consumer excluded


def test_plan_empty_when_no_consumer():
    idx = {"tests/test_x.py": "def test_x(): pass"}
    plan, log = plan_f2p_selection(["tests/data/orphan_fixture.py"], idx)
    assert plan == [] and "no_relevant_test" in log             # → likely_harness_gap upstream


def test_plan_excludes_data_dir_pyfiles_from_running(monkeypatch=None):
    # a .py fixture under tests/data that *looks* like a test module must NOT be run;
    # it is only a token source mapping to the real consumer test.
    idx = {
        "tests/data/fmtonoff.py": "def test_looks_like_a_test(): pass",   # actually a data input
        "tests/test_black.py": "def test_fmtonoff(): assert fmtonoff",
    }
    plan, log = plan_f2p_selection(["tests/data/fmtonoff.py"], idx)
    assert all(not f.startswith("tests/data/") for f, _ in plan)          # data file never run
    assert ("tests/test_black.py", "fmtonoff") in plan                    # real consumer instead


def test_plan_conftest_uses_declared_fixture_names():
    idx = {
        "tests/conftest.py": "def make_widget():\n    return 1",
        "tests/test_w.py": "def test_w(make_widget): assert make_widget",
    }
    plan, log = plan_f2p_selection(["tests/conftest.py"], idx)
    assert ("tests/test_w.py", "make_widget") in plan


def _adm(cid, fp):
    return CandidateMeta(candidate_id=cid, project="p", issue=1, installed=True, stable=True,
                         reproducible=True, degenerate=False, fingerprint=fp,
                         patch=PatchMetrics(files=1, added=5, deleted=0, hunks=2, locality="single-file"))


# --- fingerprint: empirical family from the real F2P exception, then patch shape --------
def test_fingerprint_prefers_real_exception():
    assert fingerprint("E   AttributeError: 'NoneType' has no attribute 'x'", "", []) == "Attribute"
    assert fingerprint("ModuleNotFoundError: No module named 'foo'", "", []) == "ImportError"
    assert fingerprint("E   TypeError: bad operand", "", []) == "Typing"


def test_fingerprint_falls_back_to_patch_shape():
    assert fingerprint("", "+import os\n", ["cookiecutter/config.py"]) == "ImportError"
    assert fingerprint("", "-x=1\n+x=2\n", ["setup.py"]) == "Packaging"
    assert fingerprint("", "+    await client.get()\n", ["a.py"]) == "Async"
    assert fingerprint("", "+    p = os.path.join(a, b)\n", ["a.py"]) == "Path"
    assert fingerprint("", "-  return 1\n+  return 2\n", ["a.py"]) == "Logic"  # default


# --- patch metrics: objective diff counts -----------------------------------------------
def test_patch_metrics_counts_and_locality():
    files = [{"additions": 4, "deletions": 1, "patch": "@@ -1 +1 @@\n@@ -9 +9 @@\n"}]
    m = patch_metrics(files)
    assert (m.files, m.added, m.deleted, m.hunks, m.changed_lines) == (1, 4, 1, 2, 5)
    assert m.locality == "single-file"
    assert patch_metrics([{}, {}]).locality == "multi-file"


# --- degenerate rejection (frozen rule) -------------------------------------------------
def test_is_degenerate_only_trivial_patches():
    assert is_degenerate(PatchMetrics(files=1, added=1, deleted=0, hunks=1, locality="single-file")) is True
    assert is_degenerate(PatchMetrics(files=1, added=4, deleted=1, hunks=2, locality="single-file")) is False


# --- decide: the frozen gate + reject reasons -------------------------------------------
def test_decide_records_reject_reasons():
    base = dict(candidate_id="p-1", project="p", issue=1,
                patch=PatchMetrics(files=1, added=5, deleted=0, hunks=2, locality="single-file"),
                fingerprint="Logic", degenerate=False)
    assert decide(CandidateMeta(**base, installed=False)).reject_reason == "install_failed"
    assert decide(CandidateMeta(**base, installed=True, stable=False)).reject_reason == "flaky"
    assert decide(CandidateMeta(**base, installed=True, stable=True,
                                reproducible=False)).reject_reason == "not_reproduced_under_current_harness"
    assert decide(CandidateMeta(**base, installed=True, stable=True, reproducible=False,
                                nonrepro_class="likely_harness_gap")).reject_reason == "likely_harness_gap"
    deg = {**base, "degenerate": True}
    assert decide(CandidateMeta(**deg, installed=True, stable=True,
                                reproducible=True)).reject_reason == "degenerate_patch"
    ok = decide(CandidateMeta(**base, installed=True, stable=True, reproducible=True))
    assert ok.admitted is True and ok.reject_reason == ""


# --- report: separate fingerprint distributions for admitted vs rejected ----------------
def test_report_splits_fingerprint_distributions():
    metas = [
        CandidateMeta(candidate_id="a", project="p", issue=1, installed=True, stable=True,
                      reproducible=True, degenerate=False, fingerprint="Logic",
                      patch=PatchMetrics(files=1, added=5, deleted=0, hunks=2, locality="single-file")),
        CandidateMeta(candidate_id="b", project="p", issue=2, installed=True, stable=True,
                      reproducible=True, degenerate=True, fingerprint="Packaging",
                      patch=PatchMetrics(files=1, added=1, deleted=0, hunks=1, locality="single-file")),
        CandidateMeta(candidate_id="c", project="p", issue=3, installed=False,
                      fingerprint="ImportError"),
    ]
    r = build_report("small", metas)
    assert (r.total, r.admitted, r.rejected, r.reproducible) == (3, 1, 2, 2)
    assert r.fingerprints_admitted == {"Logic": 1}
    assert r.fingerprints_rejected == {"Packaging": 1, "ImportError": 1}   # rejected tracked too


# --- recommend: the three frozen verdicts -----------------------------------------------
def test_recommend_sufficient_needs_count_and_diversity():
    diverse = build_report("s", [_adm(f"a{i}", fp) for i, fp in
                                 enumerate(["Logic", "Parser", "Path", "Async", "Attribute", "Typing"])])
    assert recommend(diverse)[0] == "SUFFICIENT FOR GATE 2"
    # 6 admitted but all identical fingerprint → quantitatively enough, not diverse enough
    homogeneous = build_report("s", [_adm(f"b{i}", "Logic") for i in range(6)])
    assert recommend(homogeneous)[0] == "QUANTITATIVELY SUFFICIENT, DIVERSITY INSUFFICIENT"


def test_recommend_insufficient_when_few_admitted():
    assert recommend(build_report("s", [_adm("a", "Logic"), _adm("b", "Parser")]))[0] == "INSUFFICIENT YIELD"


def test_recommend_environment_failure_when_installs_dominate():
    metas = [CandidateMeta(candidate_id=f"c{i}", project="p", issue=i, installed=False)
             for i in range(4)]
    assert recommend(build_report("s", metas))[0] == "ENVIRONMENT/DEPENDENCY FAILURE"
