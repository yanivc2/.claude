"""The bounded token-count adapter (P2m §6, §8, §9).

Measures **input** tokens only, through the provider's token-counting endpoint — never
a generation call. It is fail-closed in every direction:

* no resolvable credential → :class:`CredentialUnavailableError`, not a guess;
* any model other than the one authorised pilot model → :class:`UnsupportedModelError`;
* the budget must authorise each call *before* it is sent;
* a zero count for non-empty input → :class:`ZeroTokenMeasurementError`.

The API key is never read into a variable here, never logged, never stored. The client
is injected; the real path constructs an ``anthropic`` client that reads the key from
the environment itself, and a test injects a stub so the pipeline can be exercised
offline without a key. A stub verifies the *pipeline* — it is never a real token count,
and the pilot labels stub-sourced runs accordingly.
"""
from __future__ import annotations

from typing import Any, Callable, Optional, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

from .budget import PilotBudget
from .entities import CountingMethod
from .errors import (
    CredentialUnavailableError,
    GenerationForbiddenError,
    UnsupportedModelError,
    ZeroTokenMeasurementError,
)

#: The single authorised pilot model (P2m §7): the cheaper of the real catalogue models,
#: pinned to its dated snapshot so a moving alias cannot change what was measured.
ALLOWED_MODEL_IDS = frozenset({"claude-haiku-4-5", "claude-haiku-4-5-20251001"})
PILOT_MODEL_SNAPSHOT = "claude-haiku-4-5-20251001"


class CountResult(BaseModel):
    """One token-count reading."""

    model_config = ConfigDict(frozen=True)

    input_tokens: int
    method: CountingMethod
    request_id: Optional[str] = None


@runtime_checkable
class TokenCounter(Protocol):
    """Counts input tokens for one body of text. Input only — never generation."""

    def count(self, text: str, *, system: Optional[str] = None,
              tools: Optional[list[dict[str, Any]]] = None) -> CountResult: ...


class AnthropicCountTokensCounter:
    """Counts via ``client.messages.count_tokens``. Fail-closed and budget-guarded.

    ``client`` is injected. When it is ``None`` the real ``anthropic`` client is built
    and reads its key from the environment; if no credential resolves, this raises
    :class:`CredentialUnavailableError` at construction rather than later.
    """

    def __init__(self, *, budget: PilotBudget, model_id: str = "claude-haiku-4-5",
                 client: Any = None, client_factory: Optional[Callable[[], Any]] = None,
                 ) -> None:
        if model_id not in ALLOWED_MODEL_IDS:
            raise UnsupportedModelError(
                f"P2m measures only {sorted(ALLOWED_MODEL_IDS)}; refused {model_id!r}")
        self._budget = budget
        self._model = PILOT_MODEL_SNAPSHOT
        self._client = client if client is not None else self._build_client(client_factory)

    @property
    def budget(self) -> PilotBudget:
        return self._budget

    @staticmethod
    def _build_client(factory: Optional[Callable[[], Any]]) -> Any:
        try:
            if factory is not None:
                return factory()
            import anthropic  # imported lazily so the package loads without the SDK
            client = anthropic.Anthropic()    # reads the key from the environment itself
        except Exception as exc:              # missing SDK or client build failure
            raise CredentialUnavailableError(
                "could not build an API client for the token-count pilot; measurement "
                f"is BLOCKED and no count will be fabricated ({type(exc).__name__})") from exc
        # The SDK constructs happily without a key and only errors at call time, so the
        # credential is checked HERE — fail-closed at construction, per P2m §9, rather
        # than discovering the block mid-run.
        if not (getattr(client, "api_key", None) or getattr(client, "auth_token", None)):
            raise CredentialUnavailableError(
                "no API credential is resolvable in the environment; token-count "
                "measurement is BLOCKED and no count will be fabricated")
        return client

    def count(self, text: str, *, system: Optional[str] = None,
              tools: Optional[list[dict[str, Any]]] = None) -> CountResult:
        self._budget.authorise_call()          # fail-closed before anything is sent
        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": [{"role": "user", "content": text}],
        }
        if system is not None:
            kwargs["system"] = system
        if tools is not None:
            kwargs["tools"] = tools
        # Only count_tokens is ever called — never messages.create. Input tokens only.
        response = self._client.messages.count_tokens(**kwargs)
        input_tokens = int(getattr(response, "input_tokens"))
        if input_tokens <= 0 and text:
            raise ZeroTokenMeasurementError(
                "token-count endpoint returned zero for non-empty input; refusing to "
                "record a count we do not trust")
        request_id = getattr(response, "_request_id", None) or getattr(response, "request_id", None)
        return CountResult(
            input_tokens=input_tokens,
            method=CountingMethod.PROVIDER_COUNT_TOKENS_API,
            request_id=request_id,
        )

    # A generation guard, so a future edit cannot quietly turn this into an inference call.
    def generate(self, *_a: Any, **_k: Any) -> None:  # pragma: no cover - guard only
        raise GenerationForbiddenError("P2m measures input tokens only; no generation")
