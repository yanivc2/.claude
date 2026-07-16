"""Pure helpers of the PyBugHive project-qualifier (objective, model-free, deterministic)."""
from __future__ import annotations

from meta_orchestrator.corpus.pybughive_qual import (
    CandidateMeta,
    PatchMetrics,
    build_report,
    decide,
    fingerprint,
    is_degenerate,
    patch_metrics,
    recommend,
)


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
                                reproducible=False)).reject_reason == "not_reproducible"
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
    # 6 admitted but all identical fingerprint → diversity guard fails
    homogeneous = build_report("s", [_adm(f"b{i}", "Logic") for i in range(6)])
    assert recommend(homogeneous)[0] == "INSUFFICIENT YIELD"


def test_recommend_insufficient_when_few_admitted():
    assert recommend(build_report("s", [_adm("a", "Logic"), _adm("b", "Parser")]))[0] == "INSUFFICIENT YIELD"


def test_recommend_environment_failure_when_installs_dominate():
    metas = [CandidateMeta(candidate_id=f"c{i}", project="p", issue=i, installed=False)
             for i in range(4)]
    assert recommend(build_report("s", metas))[0] == "ENVIRONMENT/DEPENDENCY FAILURE"
