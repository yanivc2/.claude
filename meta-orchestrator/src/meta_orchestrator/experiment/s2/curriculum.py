"""Frozen training curriculum (hash-bound) — the authoritative, ordered train-task list per fold.

The execution grant must bind an EXACT literal task id + curriculum position, never a "sorted-order
first" recomputed at run time (fragile to sort key / locale / loader changes). This artifact freezes
``train_order`` once (runbook: C's train tasks in one frozen order = sorted) and is content-addressed
so any change to the order changes the hash and voids a dependent grant/anchor.
"""
from __future__ import annotations

import hashlib
import json
import os

from pydantic import BaseModel

from .gates import GateError

FROZEN_CURRICULUM_FILENAME = "s2_curriculum.frozen.json"
CURRICULUM_VERSION = "s2-curriculum-v1"


class FoldCurriculum(BaseModel):
    fold: int
    condition: str
    phase: str
    train_order: list[str]                 # exact literal task ids, in frozen learning order


class Curriculum(BaseModel):
    curriculum_version: str
    corpus_manifest_sha256: str
    folds: dict[str, FoldCurriculum]
    content_hash: str = ""

    def compute_hash(self) -> str:
        payload = {k: v for k, v in self.model_dump().items() if k != "content_hash"}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    def sealed(self) -> "Curriculum":
        return self.model_copy(update={"content_hash": self.compute_hash()})

    def task_at(self, fold: int, position: int) -> str:
        fc = self.folds[str(fold)]
        if not (0 <= position < len(fc.train_order)):
            raise GateError(f"curriculum position {position} out of range for fold {fold}")
        return fc.train_order[position]


def load_frozen_curriculum(corpus_dir: str) -> Curriculum:
    path = os.path.join(corpus_dir, FROZEN_CURRICULUM_FILENAME)
    if not os.path.exists(path):
        raise GateError(f"frozen curriculum missing: {path}")
    cur = Curriculum(**json.load(open(path)))
    if cur.curriculum_version != CURRICULUM_VERSION:
        raise GateError(f"curriculum version {cur.curriculum_version!r} != {CURRICULUM_VERSION!r}")
    if cur.content_hash != cur.compute_hash():
        raise GateError("curriculum content_hash mismatch (stale or hand-edited)")
    return cur


def build_curriculum(*, corpus_manifest_sha256: str, folds: dict[str, FoldCurriculum]) -> Curriculum:
    return Curriculum(curriculum_version=CURRICULUM_VERSION,
                      corpus_manifest_sha256=corpus_manifest_sha256, folds=folds).sealed()
