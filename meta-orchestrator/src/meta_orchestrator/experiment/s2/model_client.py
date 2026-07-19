"""The §2 production model-call path (P0.1) — the SAME entrypoint the micro-pilot will use.

The consultation flagged that a pure kwargs-builder test is self-referential: it proves the
builder omits ``effort``, not that the code the pilot actually runs omits it. ``S2ModelClient``
closes that hole. It is the one call path the pilot uses; a fake transport in the test inspects
the EXACT serialized body handed to the SDK boundary, so the contract is proven end-to-end at
$0 — no real request is ever sent unless a real client is injected AND ``complete`` is called.

No silent fallback (Decision A): if the locked model is unavailable or the call errors, this
raises ``ModelUnavailableError``. It never selects a second model — a silent fallback would be
an undetectable confound. There is exactly one model id in this path: ``contract.exact_model_id``.
"""
from __future__ import annotations

import json
import os
from typing import Any, Optional

from pydantic import BaseModel

from ..contract import AgentContract
from .contract_s2 import S2_SYSTEM_PROMPT, anthropic_request_kwargs, frozen_s2_contract


class ModelUnavailableError(RuntimeError):
    """The locked model was unavailable / the call failed. NO fallback is attempted."""


class S2ModelResponse(BaseModel):
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    returned_model: str = ""


class S2ModelClient:
    """Single production call path for the §2 attempt. Client is injected (fake in tests)."""

    def __init__(self, contract: Optional[AgentContract] = None, *, client: Any = None,
                 system: Optional[str] = None) -> None:
        self.contract = contract or frozen_s2_contract()
        self._client = client
        self.system = system if system is not None else S2_SYSTEM_PROMPT
        # captured on every call so tests (and audits) can inspect the exact wire body.
        self.last_request_kwargs: Optional[dict] = None
        self.last_request_json: Optional[str] = None

    def build_request(self, prompt: str) -> dict[str, Any]:
        """The exact kwargs handed to the SDK — built ONLY via the frozen contract builder."""
        return anthropic_request_kwargs(self.contract, prompt=prompt, system=self.system)

    def _ensure_client(self) -> Any:
        if self._client is None:                       # real construction is lazy; tests inject.
            import anthropic
            # max_retries=0: the SDK retries connection errors / 408 / 409 / 429 / 5xx TWICE by
            # default, so "one harness call" could silently become up to THREE HTTP requests —
            # breaking attempt accounting and cost control. The HARNESS owns all retries under the
            # frozen, condition-blind RETRY_POLICY; the SDK does none.
            api_key = os.environ.get("META_ORCH_API_KEY")
            if api_key:
                base_url = os.environ.get("META_ORCH_API_BASE_URL", "https://api.anthropic.com")
                self._client = anthropic.Anthropic(api_key=api_key, base_url=base_url,
                                                   max_retries=0)
            else:
                self._client = anthropic.Anthropic(max_retries=0)
        return self._client

    def build_request_messages(self, messages: list[dict]) -> dict[str, Any]:
        """R1/R2 unified: the frozen kwargs shape (model/system/thinking/max_tokens) with a given
        multi-turn ``messages`` list. R2 is a 3-turn history; R1 is a single user message."""
        kwargs = dict(self.build_request(""))          # frozen model/system/thinking/max_tokens
        kwargs["messages"] = list(messages)
        return kwargs

    def complete(self, prompt: str) -> S2ModelResponse:
        return self.complete_messages([{"role": "user", "content": prompt}])

    def complete_messages(self, messages: list[dict]) -> S2ModelResponse:
        kwargs = self.build_request_messages(messages)
        self.last_request_kwargs = kwargs
        self.last_request_json = json.dumps(kwargs, sort_keys=True)   # exact serialized body
        client = self._ensure_client()
        try:
            msg = client.messages.create(**kwargs)     # the ONE model call; no fallback around it
        except Exception as exc:                       # locked model unavailable / transport error
            raise ModelUnavailableError(
                f"{self.contract.exact_model_id}: call failed with no fallback ({exc})") from exc
        return _parse_message(msg, requested_model=self.contract.exact_model_id)


def _parse_message(msg: Any, *, requested_model: str) -> S2ModelResponse:
    text = "".join(getattr(b, "text", "") for b in getattr(msg, "content", [])
                   if getattr(b, "type", None) == "text")
    usage = getattr(msg, "usage", None)
    returned = getattr(msg, "model", "") or requested_model
    if returned and returned != requested_model:
        # A different model came back than was locked — a confound, surfaced loudly.
        raise ModelUnavailableError(
            f"model mismatch: requested {requested_model!r} but received {returned!r}")
    return S2ModelResponse(
        text=text,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
        thinking_tokens=getattr(usage, "thinking_tokens", 0) or 0,   # billed as output
        returned_model=returned,
    )
