"""Path-aware leak screen (write-gate leak rule v2) — pre-registered fixtures.

The old rule rejected ANY "/", so natural-language technical phrasing ("parser/tokenizer",
"stdout/stderr") was flagged as a path leak and blocked legitimate lessons. The v2 rule is
path-aware: a lone slash-joined word pair is allowed; a token that genuinely looks like a
filesystem path is rejected fail-closed. These fixtures freeze the ruling (mirrored by
examples/s2_leak_screen_audit.py) and guard the non-path leak rules that must still fire.
"""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.lesson import (Lesson, LessonRejected, LessonTrigger,
                                                 _find_path_leak, validate_lesson)

# --- natural language: a lone slash is NOT a path ----------------------------------------
MUST_PASS = ["parser/tokenizer", "stdout/stderr", "input/output", "producer/consumer",
             "read/write", "and/or", "module/function", "either/or", "client/server"]

# --- clarification A: ordinary dotted prose is never a filename (fixed extension allowlist) ---
PROSE_PASS = ["e.g.", "i.e.", "version.2", "etc.", "the value 3.14", "range 0..10"]

# --- clarification B: scheme:// URLs pass regardless of separator count -------------------
URL_PASS = ["https://example.com/docs", "http://localhost/api",
            "https://docs.python.org/3/library", "http://example.org/a/b/c", "git+ssh://host/x/y/z"]

# --- genuine filesystem paths: always a leak ---------------------------------------------
MUST_REJECT = ["src/black/linegen.py", "tests/test_black.py", "../tokenize.py",
               "/home/user/project/file.py", r"C:\repo\black\driver.py", "blib2to3/pgen2/tokenize"]

# --- a URL that embeds a real source path is still a leak (via the extension rule) --------
URL_REJECT = ["https://x/src/black/linegen.py", "http://h/a/b/c/tokenize.py"]

# --- frozen boundary rulings -------------------------------------------------------------
BOUNDARY = {"black/tokenizer": None, "module/function": None, "foo/bar/baz": "multi-segment path"}


@pytest.mark.parametrize("s", MUST_PASS)
def test_natural_language_slash_is_not_a_path(s):
    assert _find_path_leak(s) is None
    assert _find_path_leak(f"prefer a {s} split for clarity") is None


@pytest.mark.parametrize("s", PROSE_PASS)
def test_ordinary_dotted_prose_is_not_a_filename(s):
    # clarification A: only the frozen extension allowlist counts, so prose is never a filename.
    assert _find_path_leak(s) is None
    assert _find_path_leak(f"note {s} in the summary") is None


@pytest.mark.parametrize("s", URL_PASS)
def test_scheme_url_not_rejected_by_separator_count(s):
    # clarification B: a scheme:// URL is not a repo path merely because it has several separators.
    assert _find_path_leak(s) is None
    assert _find_path_leak(f"see {s} for details") is None


@pytest.mark.parametrize("s", URL_REJECT)
def test_url_embedding_a_real_source_path_still_rejected(s):
    assert _find_path_leak(s) is not None


@pytest.mark.parametrize("s", MUST_REJECT)
def test_real_path_is_detected(s):
    assert _find_path_leak(s) is not None
    assert _find_path_leak(f"edit {s} to fix it") is not None


@pytest.mark.parametrize("s,expect", BOUNDARY.items())
def test_boundary_rulings_are_frozen(s, expect):
    got = _find_path_leak(s)
    assert (got is None) == (expect is None)


def _lesson(actions):
    return Lesson(lesson_id="L-x", task_family="whitespace",
                  trigger=LessonTrigger(symptoms=["output differs"]), recommended_action=actions)


def test_lesson_with_natural_language_slash_is_accepted():
    # exactly the shape the black-112 attempt produced — no path, so it must pass the screen now.
    validate_lesson(_lesson([
        "Remove debug print statements from production tokenizer code",
        "Debug/diagnostic code should not be left in parser/tokenizer modules",
        "Avoid unexpected stdout/stderr output during tokenization"]))


def test_lesson_with_real_path_is_rejected():
    with pytest.raises(LessonRejected):
        validate_lesson(_lesson(["edit src/black/linegen.py at the boundary"]))


def test_bare_source_filename_still_rejected():
    with pytest.raises(LessonRejected):
        validate_lesson(_lesson(["edit solution.py to fix it"]))


def test_non_path_leak_rules_still_fire():
    # line numbers / code / assertions / concrete values remain rejected (unchanged behaviour).
    for bad in ["change line 42", "assert sum_to(3) == 6", "return 15 to fix it"]:
        with pytest.raises(LessonRejected):
            validate_lesson(_lesson([bad]))


def test_no_task_specific_exception_smuggled():
    # the screen is task-agnostic: it never special-cases a task name or an observed lesson id.
    import inspect

    import meta_orchestrator.experiment.lesson as L
    src = inspect.getsource(L)
    for token in ("black-112", "cand-3e9ae815aa", "tokenizer/parser"):
        assert token not in src
