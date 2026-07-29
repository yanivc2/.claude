"""Signed holdout manifest (v2-corpus §10).

The holdout is locked BEFORE learning: each task is content-hashed and the set sealed. If
any holdout task changes (or a result is used to edit the corpus), verification fails —
signalling the holdout has become a validation set and the generalization claim is void.
The manifest hash is time-independent (reproducible); ``sealed_at`` is metadata only.
"""
from __future__ import annotations

import hashlib

from pydantic import BaseModel, Field

from ..utils import now_iso
from .models import CorpusTask


class HoldoutManifest(BaseModel):
    version: int = 1
    task_ids: list[str] = Field(default_factory=list)
    task_hashes: dict[str, str] = Field(default_factory=dict)
    manifest_hash: str = ""
    sealed_at: str = ""


def _task_hash(task: CorpusTask) -> str:
    payload = task.model_dump_json()  # includes hidden tests + reference → any change is detected
    return hashlib.sha256(payload.encode()).hexdigest()


def _manifest_hash(task_hashes: dict[str, str]) -> str:
    joined = "\n".join(f"{tid}:{task_hashes[tid]}" for tid in sorted(task_hashes))
    return hashlib.sha256(joined.encode()).hexdigest()


def seal_holdout(tasks: list[CorpusTask]) -> HoldoutManifest:
    hashes = {t.task_id: _task_hash(t) for t in tasks}
    return HoldoutManifest(
        task_ids=sorted(hashes), task_hashes=hashes,
        manifest_hash=_manifest_hash(hashes), sealed_at=now_iso(),
    )


def verify_holdout(manifest: HoldoutManifest, tasks: list[CorpusTask]) -> bool:
    hashes = {t.task_id: _task_hash(t) for t in tasks}
    return (sorted(hashes) == manifest.task_ids
            and hashes == manifest.task_hashes
            and _manifest_hash(hashes) == manifest.manifest_hash)
