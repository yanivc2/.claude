"""Provenance-aware reference-fix leakage screen (replaces over-broad reference_patch_tokens).

The old screen pulled 431 tokens from the FULL reference-fix files (incl. English words from
comments/docstrings) and matched them as SUBSTRINGS — so a natural technical lesson was almost
un-bankable. The frozen screen keeps only new, non-public, corpus-unique fix identifiers and matches
EXACT tokens. These tests freeze that behavior.
"""
from __future__ import annotations

import builtins
import keyword
import os

import pytest

from meta_orchestrator.experiment.lesson import (Lesson, LessonRejected, LessonTrigger,
                                                 validate_lesson)
from meta_orchestrator.experiment.s2.forbidden_tokens import load_frozen_forbidden_tokens

_CORPUS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")

# ordinary words that a technical lesson may freely use — must NEVER be forbidden tokens.
MUST_PASS_WORDS = ["behavior", "parser", "tokenizer", "comments", "function", "exception",
                   "preserve formatting behavior", "handle stdout/stderr output"]


def _lesson(actions):
    return Lesson(lesson_id="L-x", task_family="whitespace",
                  trigger=LessonTrigger(symptoms=["output differs"]), recommended_action=actions)


def test_frozen_screen_loads_and_black112_is_empty():
    ft = load_frozen_forbidden_tokens(_CORPUS)
    assert ft.content_hash == ft.compute_hash()
    assert ft.match == "exact-token"
    # black-112 (the task re-run in the final sequence) must have NO forbidden tokens.
    assert ft.for_task("black-112") == []


def test_no_forbidden_token_is_an_ordinary_word_or_keyword():
    ft = load_frozen_forbidden_tokens(_CORPUS)
    kw = set(keyword.kwlist) | set(dir(builtins))
    denylist = {"behavior", "however", "example", "result", "value", "parser", "tokenizer"}
    for tid in ft.tasks:
        for tok, prov in ft.tasks[tid]["forbidden"].items():
            assert prov["corpus_df"] <= 1, (tid, tok)          # corpus-unique
            assert tok not in kw
            assert tok.lower() not in denylist


@pytest.mark.parametrize("word", MUST_PASS_WORDS)
def test_ordinary_technical_words_pass_the_lesson_screen(word):
    # with a realistic frozen forbidden set, a lesson using ordinary words is NOT rejected.
    toks = load_frozen_forbidden_tokens(_CORPUS).for_task("black-329")   # a task WITH forbidden tokens
    validate_lesson(_lesson([f"remember to {word} where appropriate"]), forbidden_values=toks)


def test_exact_token_match_not_substring():
    # a forbidden compound identifier rejects only an EXACT-token replay, not a substring.
    toks = ["normalize_fmt_off"]
    with pytest.raises(LessonRejected):
        validate_lesson(_lesson(["call normalize_fmt_off first"]), forbidden_values=toks)
    validate_lesson(_lesson(["normalize the whitespace"]), forbidden_values=toks)  # substring → OK


def test_new_fix_identifier_is_rejected():
    # a genuine fix-only identifier replayed verbatim is caught.
    toks = load_frozen_forbidden_tokens(_CORPUS).for_task("black-329")
    assert toks, "expected black-329 to have forbidden fix identifiers"
    with pytest.raises(LessonRejected):
        validate_lesson(_lesson([f"reuse {toks[0]} from the fix"]), forbidden_values=toks)
