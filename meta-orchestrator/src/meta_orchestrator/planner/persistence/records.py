"""Domain artifact ↔ storage record, with the hash checked on the way back.

Writing: build the artifact (so domain validation runs), take its canonical payload,
take its full SHA-256, store both. Reading: load the payload, recompute the hash,
compare it with the stored one, then rebuild the artifact — which runs domain
validation a second time.

The double check is deliberate. The hash catches a payload edited outside the
application; the rebuild catches a payload that is intact but no longer *means* what it
did, because the domain rules moved. Either way the record is refused rather than
returned, because a governance record that might be wrong is worse than one that is
missing: the missing one stops you.
"""
from __future__ import annotations

import json
from typing import Any, Callable, TypeVar

from ..governance.canonical import canonical_json, content_hash
from .errors import CorruptRecordError

T = TypeVar("T")


def dump(artifact: Any) -> tuple[str, str]:
    """Serialise an artifact to ``(payload, full_hash)``."""
    payload = artifact.canonical_payload()
    return canonical_json(payload), content_hash(payload)


def load(raw_payload: str, stored_hash: str, *, table: str, entity_id: str,
         rebuild: Callable[[dict[str, Any]], T]) -> T:
    """Verify a stored record and rebuild the artifact, or raise.

    ``rebuild`` receives the decoded payload and must reconstruct the domain object,
    so its validators run. A record that will not rebuild is corrupt in the way that
    matters, whatever its hash says.
    """
    payload = json.loads(raw_payload)
    computed = content_hash(payload)
    if computed != stored_hash:
        raise CorruptRecordError(table, entity_id, stored_hash, computed)
    try:
        return rebuild(payload)
    except Exception as exc:                      # domain validation failed on reload
        raise CorruptRecordError(
            table, entity_id, stored_hash,
            f"{computed} (rebuild failed: {exc})") from exc


def verify_only(raw_payload: str, stored_hash: str, *, table: str,
                entity_id: str) -> dict[str, Any]:
    """Check the hash and return the payload, without rebuilding.

    For artifacts whose canonical payload is a lossy projection of the object — the
    hash still proves the record is unaltered, and the caller is explicitly working
    with the payload rather than a reconstructed domain object.
    """
    payload = json.loads(raw_payload)
    computed = content_hash(payload)
    if computed != stored_hash:
        raise CorruptRecordError(table, entity_id, stored_hash, computed)
    return payload
