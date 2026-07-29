"""Frozen, provenance-aware reference-fix leakage screen (replaces the over-broad
``reference_patch_tokens``). Each task's forbidden set is the list of NEW code identifiers that:
appear only in added/replaced production-code lines of the reference diff; are not comments,
docstrings or string contents; are absent from the buggy source and the public statement; and are
unique in the corpus (document frequency <= 1). Built offline by
``examples/s2_build_forbidden_tokens.py``; matched downstream by EXACT token (whole word), never
substring — so a forbidden ``normalize_fmt_off`` never rejects a lesson that merely says
``normalize``.
"""
from __future__ import annotations

import hashlib
import json
import os

from pydantic import BaseModel

from .gate_error import GateError

FROZEN_FORBIDDEN_FILENAME = "s2_forbidden_tokens.frozen.json"
FORBIDDEN_TOKENS_VERSION = "s2-forbidden-tokens-v1"


class FrozenForbiddenTokens(BaseModel):
    schema_version: str
    match: str
    min_ident_len: int
    tasks: dict[str, dict]                 # task_id -> {"family": str, "forbidden": {token: provenance}}
    content_hash: str

    def compute_hash(self) -> str:
        payload = {k: v for k, v in self.model_dump().items() if k != "content_hash"}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    def for_task(self, task_id: str) -> list[str]:
        """The frozen forbidden tokens for a task (empty list if the task has none)."""
        return sorted(self.tasks.get(task_id, {}).get("forbidden", {}).keys())


def load_frozen_forbidden_tokens(corpus_dir: str) -> FrozenForbiddenTokens:
    """Load + verify the frozen forbidden-token screen. Blocks on missing / stale-hash / wrong-version."""
    path = os.path.join(corpus_dir, FROZEN_FORBIDDEN_FILENAME)
    if not os.path.exists(path):
        raise GateError(f"frozen forbidden-token screen missing: {path}")
    ft = FrozenForbiddenTokens(**json.load(open(path)))
    if ft.schema_version != FORBIDDEN_TOKENS_VERSION:
        raise GateError(f"forbidden-token version {ft.schema_version!r} != {FORBIDDEN_TOKENS_VERSION!r}")
    if ft.content_hash != ft.compute_hash():
        raise GateError("forbidden-token screen content_hash mismatch (stale or hand-edited)")
    return ft
