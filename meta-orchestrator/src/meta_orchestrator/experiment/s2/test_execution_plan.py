"""Frozen test-execution plan (defect-4 fix) — the SINGLE source of the grading contract shared by
``repro`` (F2P derivation) and ``realtask`` (real grading).

The black-112 diagnostic exposed defect 4: ``repro`` derives the hidden F2P under a fixed-revision
TEST overlay (the input fixtures / regression tests the fix added), but ``realtask`` checked out the
buggy revision and ran the hidden test WITHOUT that overlay — so the hidden test could not detect the
bug (a spurious PASS). This artifact freezes, per task: the exact fixed-rev test overlay (files +
content hashes), the EXACT collected public/hidden node ids (no ``-k`` keyword guessing), and node-set
hashes. Grading applies the SAME overlay, verifies the overlay hashes and the collected node set, and
runs the EXACT nodes — a mismatch is a fail-closed ``NODE_MAPPING_DRIFT`` (apparatus), never a verdict.
"""
from __future__ import annotations

import hashlib
import json
import os

from pydantic import BaseModel, Field

from .gates import GateError

FROZEN_TEST_PLANS_FILENAME = "s2_test_execution_plans.frozen.json"
TEST_PLANS_VERSION = "s2-test-exec-plan-v1"


def _sha_list(items: list[str]) -> str:
    return hashlib.sha256(json.dumps(sorted(items), separators=(",", ":")).encode()).hexdigest()


def _sha_map(m: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(m, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class TestExecutionPlan(BaseModel):
    """The frozen grading contract for ONE task. repro derives it; realtask grades against it."""

    task_id: str
    buggy_revision: str
    fixed_revision: str
    test_overlay_files: list[str] = Field(default_factory=list)   # fixed-rev TEST files overlaid on buggy
    test_overlay_hashes: dict[str, str] = Field(default_factory=dict)  # path -> sha256(fixed content)
    overlay_aggregate_sha256: str
    public_nodes: list[str] = Field(default_factory=list)          # EXACT collected node ids
    hidden_nodes: list[str] = Field(default_factory=list)          # EXACT collected node ids
    public_node_set_sha256: str
    hidden_node_set_sha256: str
    environment_digest: str = ""
    derivation_provenance: dict = Field(default_factory=dict)

    def assert_internally_consistent(self) -> None:
        if _sha_map(self.test_overlay_hashes) != self.overlay_aggregate_sha256:
            raise GateError(f"{self.task_id}: overlay_aggregate_sha256 mismatch")
        if _sha_list(self.public_nodes) != self.public_node_set_sha256:
            raise GateError(f"{self.task_id}: public_node_set_sha256 mismatch")
        if _sha_list(self.hidden_nodes) != self.hidden_node_set_sha256:
            raise GateError(f"{self.task_id}: hidden_node_set_sha256 mismatch")
        if not self.hidden_nodes:
            raise GateError(f"{self.task_id}: empty hidden_nodes — no F2P to grade")
        if set(self.public_nodes) & set(self.hidden_nodes):
            raise GateError(f"{self.task_id}: public/hidden node overlap")


def build_plan(*, task_id: str, buggy_rev: str, fixed_rev: str, overlay_files: list[str],
               overlay_hashes: dict[str, str], public_nodes: list[str], hidden_nodes: list[str],
               environment_digest: str = "", provenance: dict | None = None) -> TestExecutionPlan:
    plan = TestExecutionPlan(
        task_id=task_id, buggy_revision=buggy_rev, fixed_revision=fixed_rev,
        test_overlay_files=sorted(overlay_files), test_overlay_hashes=dict(overlay_hashes),
        overlay_aggregate_sha256=_sha_map(overlay_hashes),
        public_nodes=sorted(public_nodes), hidden_nodes=sorted(hidden_nodes),
        public_node_set_sha256=_sha_list(public_nodes), hidden_node_set_sha256=_sha_list(hidden_nodes),
        environment_digest=environment_digest, derivation_provenance=provenance or {})
    plan.assert_internally_consistent()
    return plan


class FrozenTestExecutionPlans(BaseModel):
    schema_version: str = TEST_PLANS_VERSION
    plans: dict[str, TestExecutionPlan] = Field(default_factory=dict)
    content_hash: str = ""

    def compute_hash(self) -> str:
        payload = {"schema_version": self.schema_version,
                   "plans": {k: v.model_dump() for k, v in sorted(self.plans.items())}}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    def sealed(self) -> "FrozenTestExecutionPlans":
        return self.model_copy(update={"content_hash": self.compute_hash()})

    def plan_for(self, task_id: str) -> TestExecutionPlan:
        if task_id not in self.plans:
            raise GateError(f"no frozen test-execution plan for {task_id}")
        return self.plans[task_id]


def load_frozen_test_execution_plans(corpus_dir: str) -> FrozenTestExecutionPlans:
    """Load + verify the frozen plans (version + hash + per-plan internal consistency)."""
    path = os.path.join(corpus_dir, FROZEN_TEST_PLANS_FILENAME)
    if not os.path.exists(path):
        raise GateError(f"frozen test-execution plans missing: {path}")
    doc = json.load(open(path))
    plans = FrozenTestExecutionPlans(schema_version=doc["schema_version"],
                                     plans={k: TestExecutionPlan(**v) for k, v in doc["plans"].items()},
                                     content_hash=doc.get("content_hash", ""))
    if plans.schema_version != TEST_PLANS_VERSION:
        raise GateError(f"test-plans version {plans.schema_version!r} != {TEST_PLANS_VERSION!r}")
    if plans.content_hash != plans.compute_hash():
        raise GateError("test-execution plans content_hash mismatch (stale or hand-edited)")
    for p in plans.plans.values():
        p.assert_internally_consistent()
    return plans
