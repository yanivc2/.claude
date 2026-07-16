"""Condition-D authoring infrastructure — schema, blind leak scan, size caps, freeze.

Offline, no model. The fixture submission is generic filler ONLY to exercise the validator —
it is never the experiment's real D (which an independent author writes from D_AUTHOR_PACKET.md).
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.s2 import (DSubmission, DValidationError, PlaybookEntry,
                                             freeze_d, validate_d_submission)
from meta_orchestrator.experiment.s2.memory import SLOT_MAX_LINES, render_lines, resolve_memory
from meta_orchestrator.experiment.s2.playbook_d import _render_family

PRESENT = ["boundary", "condition_inversion", "iterator", "other_logic",
           "parser_normalization", "whitespace"]


def _entry(family: str):
    return PlaybookEntry(
        family=family,
        trigger_or_context="when the formatting output differs from what the public suite expects",
        recommended_action=["prefer a minimal targeted edit", "run the public suite before finalizing"],
        avoid=["sweeping edits across unrelated code"],
    )


def _clean_submission():
    return DSubmission(author_type="external_model", author_name="GPT",
                       entries=[_entry(f) for f in PRESENT])


# --- happy path ---------------------------------------------------------------------------
def test_clean_submission_validates_and_freezes():
    sub = _clean_submission()
    assert validate_d_submission(sub, PRESENT) == []
    pb = freeze_d(sub, PRESENT)
    assert pb.author_frozen is True and pb.author == "external_model:GPT"
    assert set(pb.by_family) == set(PRESENT)
    assert pb.content_hash() == freeze_d(_clean_submission(), PRESENT).content_hash()


def test_author_metadata_not_in_injected_content():
    pb = freeze_d(_clean_submission(), PRESENT)
    for lines in pb.by_family.values():          # provenance must never appear in injected bullets
        assert not any("GPT" in ln or "external_model" in ln for ln in lines)


def test_frozen_playbook_is_immutable():
    pb = freeze_d(_clean_submission(), PRESENT)
    with pytest.raises(Exception):
        pb.author_frozen = False                 # frozen pydantic model


def test_extra_field_rejected_at_parse():
    # a stray verification_step (old format) must be rejected, not silently dropped
    with pytest.raises(Exception):
        PlaybookEntry(family="whitespace", trigger_or_context="c",
                      recommended_action=["x"], verification_step="y")


# --- rendering parity with C --------------------------------------------------------------
def test_render_matches_c_bullet_shape_and_budget():
    pb = freeze_d(_clean_submission(), PRESENT)
    lines = render_lines(resolve_memory("D", "whitespace", playbook=pb))
    assert lines[0].startswith("@@MEM kind=static_playbook family=whitespace")
    assert all(ln.startswith("- ") for ln in lines[1:])
    assert not any("verify:" in ln for ln in lines)           # no extra verify line (parity with C)
    assert len(lines) - 1 <= SLOT_MAX_LINES


def test_injected_shape_identical_to_C():
    from meta_orchestrator.experiment.s2 import learn_bank, synthetic_task
    from meta_orchestrator.experiment.s2.lifecycle import MockLearner
    pb = freeze_d(_clean_submission(), PRESENT)
    d_lines = render_lines(resolve_memory("D", "whitespace", playbook=pb))
    bank = learn_bank([synthetic_task("t", "whitespace")], MockLearner())
    c_lines = render_lines(resolve_memory("C", "whitespace", bank=bank))
    assert d_lines[0].startswith("@@MEM kind=static_playbook")
    assert c_lines[0].startswith("@@MEM kind=family_relevant")
    assert all(ln.startswith("- ") for ln in d_lines[1:] + c_lines[1:])


# --- leak scan ----------------------------------------------------------------------------
def _one_bad(field_value):
    entries = [_entry(f) for f in PRESENT]
    entries[0] = PlaybookEntry(family=entries[0].family, trigger_or_context="ctx",
                               recommended_action=[field_value])
    return DSubmission(author_type="external_model", author_name="GPT", entries=entries)


@pytest.mark.parametrize("bad", [
    "see black-95 for the pattern",           # task/corpus id
    "edit the visitor in linegen.py",         # filename / .py
    "apply the fix in src/black",             # path separator
    "the function should return 15",          # code fragment / concrete value
    "assert the node is balanced",            # test assertion
    "the result == 42 here",                  # concrete expected value
])
def test_leaks_are_rejected(bad):
    errs = validate_d_submission(_one_bad(bad), PRESENT)
    assert any("LEAK" in e for e in errs), errs


def test_oversize_field_rejected():
    assert any("chars >" in e for e in validate_d_submission(_one_bad("x" * 250), PRESENT))


def test_too_many_entries_rejected():
    entries = [_entry(f) for f in PRESENT] + [_entry("iterator"), _entry("iterator")]
    sub = DSubmission(author_type="external_model", author_name="GPT", entries=entries)
    assert any("entries >" in e for e in validate_d_submission(sub, PRESENT))


def test_missing_family_rejected():
    entries = [_entry(f) for f in PRESENT if f != "boundary"]
    sub = DSubmission(author_type="external_model", author_name="GPT", entries=entries)
    assert any("missing advice" in e for e in validate_d_submission(sub, PRESENT))


def test_unknown_family_rejected():
    entries = [_entry(f) for f in PRESENT] + [_entry("state_mutation")]  # absent from corpus
    sub = DSubmission(author_type="external_model", author_name="GPT", entries=entries)
    assert any("unknown/absent" in e for e in validate_d_submission(sub, PRESENT))


def test_missing_author_metadata_rejected():
    sub = DSubmission(author_type="", author_name="", entries=[_entry(f) for f in PRESENT])
    assert any("author_type and author_name" in e for e in validate_d_submission(sub, PRESENT))


def test_freeze_raises_on_dirty_submission():
    with pytest.raises(DValidationError):
        freeze_d(_one_bad("return 15 from linegen.py"), PRESENT)


def test_render_family_helper_shape():
    lines = _render_family([_entry("whitespace")])
    assert lines[0] == "prefer a minimal targeted edit"
    assert not any(ln.startswith("verify: ") for ln in lines)   # verification folded into actions
    assert any(ln.startswith("avoid: ") for ln in lines)
