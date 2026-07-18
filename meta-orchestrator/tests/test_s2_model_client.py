"""P0.1 — production-path interception test: prove the ACTUAL call path is contract-faithful.

A fake transport records the exact body handed to ``client.messages.create`` (and its serialized
JSON). This proves the code the pilot runs — not merely a pure helper — omits ``effort`` and the
sampling params, pins the snapshot, and never falls back. $0: no real request is sent.
"""
from __future__ import annotations

import json

import pytest

from meta_orchestrator.experiment.s2.contract_s2 import frozen_s2_contract
from meta_orchestrator.experiment.s2.model_client import (ModelUnavailableError, S2ModelClient)


class _FakeUsage:
    input_tokens = 11
    output_tokens = 22
    thinking_tokens = 5


class _FakeBlock:
    type = "text"
    text = "fixed the bug"


class _RecordingClient:
    """Captures the kwargs the SDK boundary receives; returns a canned message."""

    def __init__(self, returned_model="claude-haiku-4-5-20251001"):
        self.captured = None
        self._returned_model = returned_model
        self.messages = self                       # so client.messages.create resolves here

    def create(self, **kwargs):
        self.captured = kwargs
        return type("Msg", (), {"content": [_FakeBlock()], "usage": _FakeUsage(),
                                "model": self._returned_model})()


class _RaisingClient:
    def __init__(self):
        self.messages = self

    def create(self, **kwargs):
        raise RuntimeError("503 overloaded")


def test_production_path_sends_exact_contract_body():
    fake = _RecordingClient()
    client = S2ModelClient(frozen_s2_contract(), client=fake)
    resp = client.complete("fix the bug in the given file")

    body = fake.captured
    assert body["model"] == "claude-haiku-4-5-20251001"
    assert body["max_tokens"] == 4096
    assert body["thinking"] == {"type": "enabled", "budget_tokens": 1024}
    # the serialized wire body must not carry the forbidden keys anywhere
    serialized = client.last_request_json
    assert serialized == json.dumps(body, sort_keys=True)
    for banned in ("effort", "output_config", "temperature", "top_p", "top_k"):
        assert banned not in serialized
    assert resp.text == "fixed the bug"
    assert resp.output_tokens == 22 and resp.input_tokens == 11


def test_no_fallback_raises_model_unavailable():
    client = S2ModelClient(frozen_s2_contract(), client=_RaisingClient())
    with pytest.raises(ModelUnavailableError):
        client.complete("x")                       # no second model is ever tried


def test_model_mismatch_is_surfaced_loudly():
    fake = _RecordingClient(returned_model="claude-haiku-4-5-some-other-build")
    client = S2ModelClient(frozen_s2_contract(), client=fake)
    with pytest.raises(ModelUnavailableError):
        client.complete("x")                       # a different model than locked → confound


def test_only_one_model_id_in_the_path():
    fake = _RecordingClient()
    client = S2ModelClient(frozen_s2_contract(), client=fake)
    client.complete("x")
    # the request references exactly the locked snapshot and nothing else model-shaped
    assert fake.captured["model"] == client.contract.exact_model_id
    assert "model" not in {k for k in fake.captured if k != "model"}
