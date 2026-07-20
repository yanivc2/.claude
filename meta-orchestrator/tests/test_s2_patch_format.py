"""Frozen SEARCH/REPLACE patch format: exact applier, taxonomy, fail-closed classification, and the
capacity round-trip proving every one of the 27 reference fixes is representable (so unified-diff is
unnecessary). The reference encoder here is EVALUATOR-ONLY and offline — it never feeds a prompt.
"""
from __future__ import annotations

import difflib
import json
import os

import pytest

from meta_orchestrator.experiment.s2 import patch_format as PF
from meta_orchestrator.experiment.s2.canary_prompt import cap_filling_worst_envelope
from meta_orchestrator.experiment.s2.response_parser import parse_model_response
from meta_orchestrator.experiment.s2.response_classification import (
    MALFORMED_OUTPUT, REFUSAL, TRUNCATED_OUTPUT, VALID_COMPLETE_OUTPUT, classify_response)

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# --------------------------------------------------------------------------- exact applier
def test_unique_search_applies_once():
    out = PF.apply_search_replace("a\nb\nc\n", [PF.SearchReplace("b", "B")])
    assert out == "a\nB\nc\n"


def test_zero_match_is_not_found():
    with pytest.raises(PF.PatchFormatError) as e:
        PF.apply_search_replace("a\nb\n", [PF.SearchReplace("zzz", "x")])
    assert e.value.code == PF.SEARCH_NOT_FOUND


def test_two_matches_is_ambiguous():
    with pytest.raises(PF.PatchFormatError) as e:
        PF.apply_search_replace("x\nx\n", [PF.SearchReplace("x", "y")])
    assert e.value.code == PF.SEARCH_AMBIGUOUS


def test_overlapping_spans_rejected():
    with pytest.raises(PF.PatchFormatError) as e:
        PF.apply_search_replace("abcdef", [PF.SearchReplace("abc", "X"), PF.SearchReplace("cde", "Y")])
    assert e.value.code == PF.OVERLAP


def test_two_nonoverlapping_blocks_same_file_deterministic():
    # earlier replacement must not shift later match positions (applied high→low)
    out = PF.apply_search_replace("k1=aaa\nk2=bbb\n",
                                  [PF.SearchReplace("aaa", "A"), PF.SearchReplace("bbb", "BBBB")])
    assert out == "k1=A\nk2=BBBB\n"


# --------------------------------------------------------------------------- structural parser
def _wrap(patch_body, *, lesson=False):
    lead = ('### LESSON\n{"recommended_action": ["x"], "avoid": ["y"]}\n') if lesson else ""
    return lead + "### PATCH\n" + patch_body + "### END"


def test_empty_search_rejected():
    body = "### FILE: a.py\n<<<<<<< SEARCH\n=======\nx=1\n>>>>>>> REPLACE\n"
    p = parse_model_response(_wrap(body), allowed_source_files=["a.py"], task_family="f", is_train=False)
    assert not p.ok and p.reason == "PATCH_SCHEMA_INVALID:empty_search"


def test_forbidden_path_rejected():
    body = "### FILE: tests/t.py\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n"
    p = parse_model_response(_wrap(body), allowed_source_files=["a.py"], task_family="f", is_train=False)
    assert not p.ok and p.reason.startswith(PF.PATH_FORBIDDEN)


def test_sentinel_collision_rejected():
    # a body line equal to a structural sentinel (### PATCH) must be rejected, not mis-parsed
    body = "### FILE: a.py\n<<<<<<< SEARCH\na\n=======\n### PATCH\n>>>>>>> REPLACE\n"
    p = parse_model_response(_wrap(body), allowed_source_files=["a.py"], task_family="f", is_train=False)
    assert not p.ok and p.reason == "PATCH_SCHEMA_INVALID:sentinel_collision"


def test_too_many_blocks_limit_exceeded():
    one = "### FILE: a.py\n<<<<<<< SEARCH\ns{n}\n=======\nr{n}\n>>>>>>> REPLACE\n"
    body = "".join(one.format(n=i) for i in range(PF.MAX_PATCH_BLOCKS + 1))
    p = parse_model_response(_wrap(body), allowed_source_files=["a.py"], task_family="f", is_train=False)
    assert not p.ok and p.reason.startswith(PF.LIMIT_EXCEEDED)


def test_multi_file_edits_parse_in_order():
    body = ("### FILE: a.py\n<<<<<<< SEARCH\naa\n=======\nAA\n>>>>>>> REPLACE\n"
            "### FILE: b.py\n<<<<<<< SEARCH\nbb\n=======\nBB\n>>>>>>> REPLACE\n")
    p = parse_model_response(_wrap(body), allowed_source_files=["a.py", "b.py"], task_family="f",
                             is_train=False)
    assert p.ok and list(p.edits) == ["a.py", "b.py"]


# --------------------------------------------------------------------------- fail-closed classification
def test_classification_matrix():
    assert classify_response(stop_reason="max_tokens", end_marker_present=True, parse_ok=True) == TRUNCATED_OUTPUT
    assert classify_response(stop_reason="end_turn", end_marker_present=False, parse_ok=True) == TRUNCATED_OUTPUT
    assert classify_response(stop_reason="refusal", end_marker_present=True, parse_ok=True) == REFUSAL
    assert classify_response(stop_reason="end_turn", end_marker_present=True, parse_ok=False) == MALFORMED_OUTPUT
    assert classify_response(stop_reason="end_turn", end_marker_present=True, parse_ok=True) == VALID_COMPLETE_OUTPUT


# --------------------------------------------------------------------------- calibration envelope props
def test_cap_filling_envelope_is_legal_parser_valid_and_scoped():
    allowed = ["pkg/a.py", "pkg/b.py"]
    env = cap_filling_worst_envelope(allowed, train=True)
    p = parse_model_response(env, allowed_source_files=allowed, task_family="fam", is_train=True)
    assert p.ok and p.candidate_lesson is not None            # legal + parser-valid, lesson present
    assert set(p.edits).issubset(set(allowed))                # ONLY allowed paths (no leakage path)
    assert p.total_blocks == PF.MAX_PATCH_BLOCKS               # fills the frozen block cap
    total = sum(len(s) + len(r) for b in p.edits.values() for s, r in b)
    assert total <= PF.MAX_TOTAL_PATCH_CHARS                   # within the frozen total-char cap
    # no reference-fix content: the envelope is pure synthetic identifiers
    assert "def " not in env and "return" not in env


# --------------------------------------------------------------------------- 27-fix capacity round-trip
def _encode_reference_sr(buggy: str, fixed: str) -> list:
    """EVALUATOR-ONLY canonical SEARCH/REPLACE encoding of a reference fix (offline; never a prompt)."""
    b, f = buggy.splitlines(keepends=True), fixed.splitlines(keepends=True)
    sm = difflib.SequenceMatcher(None, b, f, autojunk=False)
    ranges = [[i1, i2, j1, j2] for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal"]

    def expand(r):
        lo, hi, jlo, jhi = r
        while True:
            if "".join(b[lo:hi]) and buggy.count("".join(b[lo:hi])) == 1:
                return [lo, hi, jlo, jhi]
            grew = False
            if lo > 0: lo -= 1; jlo -= 1; grew = True
            if hi < len(b): hi += 1; jhi += 1; grew = True
            if not grew: return [lo, hi, jlo, jhi]

    ranges = [expand(r) for r in ranges]
    while True:
        ranges.sort()
        merged = [ranges[0]]
        for lo, hi, jlo, jhi in ranges[1:]:
            plo, phi, pjlo, pjhi = merged[-1]
            if lo <= phi:
                merged[-1] = [min(plo, lo), max(phi, hi), min(pjlo, jlo), max(pjhi, jhi)]
            else:
                merged.append([lo, hi, jlo, jhi])
        exp = [expand(r) for r in merged]
        if exp == merged:
            ranges = merged; break
        ranges = exp
    return [PF.SearchReplace("".join(b[lo:hi]), "".join(f[jlo:jhi])) for lo, hi, jlo, jhi in ranges]


def test_all_27_reference_fixes_round_trip_through_search_replace(tmp_path):
    """Every frozen reference fix encodes as exact SEARCH/REPLACE and round-trips buggy→fixed, within
    the frozen caps — proving SEARCH/REPLACE can represent the whole corpus (unified-diff unneeded)."""
    from meta_orchestrator.experiment.s2.materialize import _ensure_clone, _read_file_at_rev
    corpus = json.load(open(os.path.join(_ROOT, "corpus", "s2_real_corpus.json")))["tasks"]
    cache = str(tmp_path / "cache")
    for tid, e in corpus.items():
        repo = _ensure_clone(e["repo_url"], cache)
        touched = 0
        for p in e["allowed_source_files"]:
            buggy = _read_file_at_rev(repo, e["buggy_rev"], p)
            fixed = _read_file_at_rev(repo, e["fixed_rev"], p)
            assert buggy is not None and fixed is not None, f"{tid}:{p} unreadable"
            if buggy == fixed:
                continue
            touched += 1
            blocks = _encode_reference_sr(buggy, fixed)
            assert len(blocks) <= PF.MAX_PATCH_BLOCKS, f"{tid}:{p} blocks>{PF.MAX_PATCH_BLOCKS}"
            assert PF.apply_search_replace(buggy, blocks) == fixed, f"{tid}:{p} round-trip mismatch"
        assert touched >= 1, f"{tid}: reference fix touched no allowed file"
