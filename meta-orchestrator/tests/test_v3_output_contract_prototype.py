"""v3 output-contract prototype — SYNTHETIC offline tests (no API). Proves the harness-side
Gate-A properties: parser acceptance on well-formed fixtures, truncation detection, 0% ambiguous
application, 0% silent partial application, multiline edits, and deterministic replay.
"""
from __future__ import annotations

import importlib.util
import json
import os

import pytest

_TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
_spec = importlib.util.spec_from_file_location(
    "v3_output_contract_prototype", os.path.join(_TOOLS, "v3_output_contract_prototype.py"))
V3 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(V3)

SRC = "def f():\n    return 0\n\ndef g():\n    return 0\n"


def _doc(edits, done=True):
    d = {"edits": edits}
    if done:
        d["done"] = True
    return json.dumps(d)


def test_wellformed_single_edit_applies():
    text = _doc([{"anchor": "def f():\n    return 0", "replacement": "def f():\n    return 1"}])
    state, out = V3.parse_and_apply(text, SRC)
    assert state == V3.OK and "def f():\n    return 1" in out and out.endswith("def g():\n    return 0\n")


def test_fenced_json_is_tolerated():
    text = "```json\n" + _doc([{"anchor": "return 0\n\ndef g", "replacement": "return 2\n\ndef g"}]) + "\n```"
    state, out = V3.parse_and_apply(text, SRC)
    assert state == V3.OK and "return 2" in out


def test_multiline_replacement():
    text = _doc([{"anchor": "def g():\n    return 0",
                  "replacement": "def g():\n    x = 1\n    return x"}])
    state, out = V3.parse_and_apply(text, SRC)
    assert state == V3.OK and "x = 1" in out


def test_malformed_json_is_malformed():
    state, out = V3.parse_and_apply("{not json at all", SRC)
    assert state in (V3.MALFORMED, V3.TRUNCATED) and out == SRC       # never mutates


def test_truncated_unterminated_json():
    state, out = V3.parse_and_apply('{"edits": [{"anchor": "def f', SRC)
    assert state == V3.TRUNCATED and out == SRC


def test_missing_done_sentinel_is_truncated():
    text = _doc([{"anchor": "return 0", "replacement": "return 1"}], done=False)
    state, out = V3.parse_and_apply(text, SRC)
    assert state == V3.TRUNCATED and out == SRC


def test_anchor_not_found_fails_closed():
    text = _doc([{"anchor": "def nonexistent()", "replacement": "x"}])
    state, out = V3.parse_and_apply(text, SRC)
    assert state == V3.APPLY_NOT_FOUND and out == SRC


def test_ambiguous_anchor_fails_closed_no_apply():
    text = _doc([{"anchor": "    return 0", "replacement": "    return 9"}])   # occurs twice
    state, out = V3.parse_and_apply(text, SRC)
    assert state == V3.AMBIGUOUS and out == SRC                        # 0% ambiguous application


def test_all_or_none_no_silent_partial():
    # first edit is valid+unique, second is not found → NOTHING is applied
    text = _doc([{"anchor": "def f():\n    return 0", "replacement": "def f():\n    return 1"},
                 {"anchor": "def missing()", "replacement": "x"}])
    state, out = V3.parse_and_apply(text, SRC)
    assert state == V3.APPLY_NOT_FOUND and out == SRC                  # no partial write


def test_overlapping_edits_fail_closed():
    text = _doc([{"anchor": "def f():\n    return 0", "replacement": "A"},
                 {"anchor": "f():\n    return 0", "replacement": "B"}])
    state, out = V3.parse_and_apply(text, SRC)
    assert state == V3.OVERLAP and out == SRC


def test_empty_edits_is_noop_not_format_failure():
    state, out = V3.parse_and_apply(_doc([]), SRC)
    assert state == V3.EMPTY_EDITS and out == SRC


def test_deterministic_replay():
    text = _doc([{"anchor": "def f():\n    return 0", "replacement": "def f():\n    return 1"},
                 {"anchor": "def g():\n    return 0", "replacement": "def g():\n    return 2"}])
    _, o1 = V3.parse_and_apply(text, SRC)
    _, o2 = V3.parse_and_apply(text, SRC)
    assert o1 == o2 and "return 1" in o1 and "return 2" in o1


def test_gate_a_metrics_zero_ambiguous_zero_partial():
    fixtures = [
        (_doc([{"anchor": "def f():\n    return 0", "replacement": "def f():\n    return 1"}]), SRC, "wellformed"),
        (_doc([{"anchor": "def g():\n    return 0", "replacement": "def g():\n    return 3"}]), SRC, "wellformed"),
        ("{bad", SRC, "malformed"),
        ('{"edits": [{"anchor": "def f', SRC, "truncated"),
        (_doc([{"anchor": "    return 0", "replacement": "    return 9"}]), SRC, "ambiguous"),
        (_doc([{"anchor": "def missing()", "replacement": "x"}]), SRC, "apply_fail"),
    ]
    m = V3.gate_a_metrics(fixtures)
    assert m["wellformed_parser_acceptance"] == 1.0
    assert m["ambiguous_application_rate"] == 0
    assert m["silent_partial_application_events"] == 0
