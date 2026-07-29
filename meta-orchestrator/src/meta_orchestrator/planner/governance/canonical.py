"""Canonical serialization and hashing for governance artifacts.

Every artifact that binds a decision — a snapshot, an admission, an approval, an
authorization, a reservation, an override — must be reducible to one exact byte
sequence, so that two parties can agree on whether they are looking at the same thing.

Two rules, both learned the hard way:

* **The full 64-hex SHA-256 is the identity.** A truncated digest is for reading, never
  for comparing, binding, or addressing. ``display_hash`` refuses anything shorter.
* **Money renders as a string.** A canonical form that round-trips through binary
  floating point is not canonical.

A content hash is **not a signature.** It proves an artifact has not changed since it
was hashed; it proves nothing about who produced it. Nothing here is cryptographic
authentication, and the docs say so in as many words.
"""
from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Protocol, runtime_checkable

from ..pricing.entities import display_hash, full_sha256

__all__ = ["Canonical", "canonical_json", "content_hash", "display_hash",
           "full_sha256", "render"]


def render(value: Any) -> Any:
    """Reduce a value to JSON-safe, exactly-representable primitives."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, float):
        raise TypeError(
            "refusing to serialize a float into a canonical payload — the value has "
            "already lost precision; pass a Decimal or a string")
    if hasattr(value, "value") and hasattr(type(value), "__members__"):
        return value.value                                   # Enum
    if hasattr(value, "canonical_payload"):
        return value.canonical_payload()
    if isinstance(value, dict):
        return {str(k): render(v) for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, (list, tuple)):
        return [render(v) for v in value]
    if hasattr(value, "amount") and hasattr(value, "currency"):   # Money
        return {"amount": str(value.amount), "currency": value.currency}
    raise TypeError(f"no canonical rendering for {type(value).__name__}")


def canonical_json(payload: dict[str, Any]) -> str:
    """Stable JSON: sorted keys, compact separators, no ASCII escaping."""
    return json.dumps(render(payload), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)


def content_hash(payload: dict[str, Any]) -> str:
    """Full 64-hex SHA-256 of the canonical form."""
    return full_sha256(canonical_json(payload))


@runtime_checkable
class Canonical(Protocol):
    """What every governance artifact must be able to do."""

    def canonical_payload(self) -> dict[str, Any]:
        ...


class CanonicalMixin:
    """Hashing behaviour shared by governance artifacts.

    Subclasses supply ``canonical_payload``; the hash follows from it, so a field that
    is not in the payload is not in the identity — which is the property the binding
    tests actually check.
    """

    def canonical_payload(self) -> dict[str, Any]:      # pragma: no cover - overridden
        raise NotImplementedError

    def canonical_json(self) -> str:
        return canonical_json(self.canonical_payload())

    def content_hash(self) -> str:
        """The artifact's identity. Full 64 hex characters."""
        return content_hash(self.canonical_payload())

    def display_hash(self) -> str:
        """Short form for logs and tables. Never used to compare or bind."""
        return display_hash(self.content_hash())
