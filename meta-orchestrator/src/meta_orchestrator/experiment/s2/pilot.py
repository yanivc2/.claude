"""Shared PRODUCTION gate logic for the paid pilot (one implementation for scripts + tests).

User rule 1: the Gate-1 / Gate-2 scripts must call the SAME functions the tests and the real run
call — no parallel re-implementation. User rule 2: offline/proxy can NEVER produce a
production-valid artifact or move the manifest to an authorized status. User rule 5: manifest
status transitions are append-only + hash-locked. User rule 6: no secrets / prompt bodies /
hidden-test data in any artifact.

This module holds: the immutable-transition ``RunManifest``; ``gate1_evaluate`` /
``gate2_evaluate`` (pure decision functions); artifact models tagged with ``token_count_source``
and ``production_valid``; and a ``assert_no_secrets`` scrubber. It performs NO network / paid call.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import re
from typing import Optional

from pydantic import BaseModel, Field

from ..verifier import verifier_config_hash
from .b1_selector import PROXY_SOURCE, REAL_SOURCE
from .contract_s2 import frozen_s2_contract
from .gates import GateError

# --- run statuses (parametric for GATE2 per fold) ----------------------------------------
UNAUTHORIZED = "UNAUTHORIZED_FOR_MESSAGES"
AUTHORIZED_FOLD1 = "AUTHORIZED_FOR_FOLD1_C_TRAINING"
BLOCKED = "BLOCKED"


def gate2_passed_status(fold: int) -> str:
    return f"GATE2_PASSED_FOLD{fold}"


def _allowed_targets(status: str) -> set[str]:
    if status == UNAUTHORIZED:
        return {AUTHORIZED_FOLD1, BLOCKED}
    if status == AUTHORIZED_FOLD1:
        return {gate2_passed_status(1), BLOCKED}
    if status.startswith("GATE2_PASSED_FOLD"):
        return {BLOCKED}                      # further fold authorizations are separate manifests
    return set()                              # BLOCKED is terminal


class Transition(BaseModel):
    from_status: str
    to_status: str
    reason: str
    timestamp: str                            # caller-supplied (deterministic in tests)
    artifact_hash: str


class RunManifest(BaseModel):
    run_id: str
    commit: str
    hashes: dict[str, str] = Field(default_factory=dict)
    budget_usd: float
    status: str = UNAUTHORIZED
    transitions: list[Transition] = Field(default_factory=list)

    def apply_transition(self, to_status: str, *, reason: str, timestamp: str,
                         artifact_hash: str) -> None:
        """Append a hash-locked transition. Never edits an existing status silently."""
        if to_status not in _allowed_targets(self.status):
            raise GateError(f"illegal transition {self.status!r} → {to_status!r}")
        self.transitions.append(Transition(from_status=self.status, to_status=to_status,
                                           reason=reason, timestamp=timestamp,
                                           artifact_hash=artifact_hash))
        self.status = to_status

    def content_hash(self) -> str:
        return hashlib.sha256(
            json.dumps(self.model_dump(), sort_keys=True).encode()).hexdigest()[:12]


def _src_hash(obj) -> str:
    return hashlib.sha256(inspect.getsource(obj).encode()).hexdigest()[:12]


def collect_frozen_hashes(corpus_dir: Optional[str] = None) -> dict[str, str]:
    """Gather the anchor hashes from code + the frozen corpus artifacts (best-effort)."""
    import os

    from ..sandbox import Sandbox
    from .canonical import CanonicalS2Request, build_canonical
    hashes: dict[str, str] = {
        "agent_contract": frozen_s2_contract().snapshot()[:16],
        "canonical_builder": _src_hash(CanonicalS2Request) + _src_hash(build_canonical),
        "verifier_config": verifier_config_hash(),
        "sandbox": _src_hash(Sandbox),
    }
    files = {
        "family_map": ("s2_family_map.json", "family_map_content_hash"),
        "scope": ("s2_scope_metadata.json", "scope_content_hash"),
        "d_playbook": ("d_playbook.frozen.json", "content_hash"),
        "pricing": ("s2_pricing.frozen.json", "content_hash"),      # a5: frozen price binding
        "budget_policy": ("s2_budget_policy.frozen.json", "content_hash"),  # approved caps binding
        "paid_spend_ledger": ("s2_paid_spend_ledger.json", "content_hash"),  # lifetime spend binding
        "curriculum": ("s2_curriculum.frozen.json", "content_hash"),        # frozen train order
        "test_execution_plans": ("s2_test_execution_plans.frozen.json", "content_hash"),  # grading contract
    }
    if corpus_dir:
        for key, (fname, field) in files.items():
            path = os.path.join(corpus_dir, fname)
            if os.path.exists(path):
                try:
                    hashes[key] = str(json.load(open(path)).get(field, "unavailable"))
                except Exception:
                    hashes[key] = "unreadable"
            else:
                hashes[key] = "absent"
        for doc in ("S2_PREPAID_FREEZE.md", "S2_AGENT_CONTRACT.md"):
            path = os.path.join(corpus_dir, doc)
            if os.path.exists(path):
                hashes[doc.replace(".md", "").lower()] = hashlib.sha256(
                    open(path, "rb").read()).hexdigest()[:12]
    return hashes


def build_run_manifest(run_id: str, commit: str, *, budget_usd: float,
                       corpus_dir: Optional[str] = None) -> RunManifest:
    """Step 0: the locked run manifest — starts UNAUTHORIZED_FOR_MESSAGES."""
    return RunManifest(run_id=run_id, commit=commit, budget_usd=budget_usd,
                       hashes=collect_frozen_hashes(corpus_dir), status=UNAUTHORIZED)


# --- Gate 1 --------------------------------------------------------------------------------
class Gate1Inputs(BaseModel):
    tests_failed: int
    tests_skipped: int
    sdk_version: str
    httpx_version: str
    serialized_body_ok: bool
    max_retries_zero_proven: bool
    context_cap_source: str                   # must be REAL_SOURCE for production
    context_cap_fits_budget: bool
    all_hashes_match: bool
    snapshot_available: bool
    snapshot_within_retirement: bool


class GateReport(BaseModel):
    gate: str
    passed: bool
    production_valid: bool
    token_count_source: str
    reasons: list[str] = Field(default_factory=list)

    def content_hash(self) -> str:
        return hashlib.sha256(
            json.dumps(self.model_dump(), sort_keys=True).encode()).hexdigest()[:12]


def gate1_evaluate(inp: Gate1Inputs) -> GateReport:
    """Pure Gate-1 decision. A proxy context-cap can NEVER be production-valid (→ cannot pass)."""
    reasons: list[str] = []
    if inp.tests_failed != 0:
        reasons.append("tests_failed")
    if inp.tests_skipped != 0:
        reasons.append("tests_skipped")
    if not (inp.sdk_version and inp.httpx_version):
        reasons.append("unpinned_sdk_or_httpx")
    if not inp.serialized_body_ok:
        reasons.append("serialized_body_not_proven")
    if not inp.max_retries_zero_proven:
        reasons.append("max_retries_not_proven")
    if inp.context_cap_source != REAL_SOURCE:
        reasons.append("context_cap_not_from_anthropic_count_tokens")
    if not inp.context_cap_fits_budget:
        reasons.append("cost_projection_over_budget")
    if not inp.all_hashes_match:
        reasons.append("hash_mismatch")
    if not inp.snapshot_available:
        reasons.append("snapshot_unavailable")
    if not inp.snapshot_within_retirement:
        reasons.append("snapshot_past_retirement")
    production_valid = inp.context_cap_source == REAL_SOURCE
    return GateReport(gate="gate1", passed=(not reasons and production_valid),
                      production_valid=production_valid, token_count_source=inp.context_cap_source,
                      reasons=reasons)


# --- Gate 2 --------------------------------------------------------------------------------
class Gate2Inputs(BaseModel):
    fold: int
    train_terminal_count: int                 # tasks with terminal non-infra outcome
    train_total: int                          # must be 18 for the real folds
    bank_frozen: bool
    bank_fold_correct: bool
    held_out_calls_made: int                  # MUST be 0 before Gate 2
    b1_source: str                            # must be REAL_SOURCE
    b1_bound_to_bank: bool
    b1_bound_to_builder: bool
    all_held_out_fit_cap: bool
    budget_sufficient_for_block: bool
    b1_qualifying_mapping_found: bool


def gate2_evaluate(inp: Gate2Inputs) -> GateReport:
    """Pure Gate-2 decision. A proxy B1 source can NEVER be production-valid (→ cannot pass)."""
    reasons: list[str] = []
    if inp.train_terminal_count != inp.train_total:
        reasons.append("training_incomplete")
    if not inp.bank_frozen:
        reasons.append("bank_not_frozen")
    if not inp.bank_fold_correct:
        reasons.append("bank_wrong_fold")
    if inp.held_out_calls_made != 0:
        reasons.append("held_out_already_started")
    if not inp.b1_qualifying_mapping_found:
        reasons.append("no_qualifying_b1_derangement")   # → STOP the whole experiment
    if inp.b1_source != REAL_SOURCE:
        reasons.append("b1_not_from_anthropic_count_tokens")
    if not inp.b1_bound_to_bank:
        reasons.append("b1_not_bound_to_bank")
    if not inp.b1_bound_to_builder:
        reasons.append("b1_not_bound_to_request_builder")
    if not inp.all_held_out_fit_cap:
        reasons.append("held_out_request_over_context_cap")
    if not inp.budget_sufficient_for_block:
        reasons.append("insufficient_budget_for_held_out_block")
    production_valid = inp.b1_source == REAL_SOURCE
    return GateReport(gate="gate2", passed=(not reasons and production_valid),
                      production_valid=production_valid, token_count_source=inp.b1_source,
                      reasons=reasons)


# --- secrets scrubber (user rule 6) ------------------------------------------------------
_SECRET_PATTERNS = [
    re.compile(r"sk-ant-", re.I), re.compile(r"api[_-]?key", re.I),
    re.compile(r"authorization", re.I), re.compile(r"bearer\s", re.I),
    re.compile(r"tests_hidden", re.I), re.compile(r"x-api-key", re.I),
]


def assert_no_secrets(artifact: BaseModel) -> None:
    """Raise if an artifact would persist an API key / auth header / hidden-test data."""
    blob = artifact.model_dump_json()
    for pat in _SECRET_PATTERNS:
        if pat.search(blob):
            raise GateError(f"artifact would persist a secret/hidden-test field (/{pat.pattern}/)")


def authorize_after_gate1(manifest: RunManifest, report: GateReport, *, timestamp: str) -> None:
    """Move to AUTHORIZED_FOR_FOLD1_C_TRAINING — ONLY on a passed, production-valid Gate-1 report."""
    if not (report.gate == "gate1" and report.passed and report.production_valid):
        raise GateError("refusing to authorize: Gate-1 report is not passed+production_valid "
                        f"(offline/proxy artifacts can never authorize) — reasons {report.reasons}")
    manifest.apply_transition(AUTHORIZED_FOLD1, reason="gate1 passed (production-valid)",
                              timestamp=timestamp, artifact_hash=report.content_hash())


def record_gate2_pass(manifest: RunManifest, report: GateReport, *, fold: int,
                      timestamp: str) -> None:
    if not (report.gate == "gate2" and report.passed and report.production_valid):
        raise GateError("refusing to mark GATE2_PASSED: report not passed+production_valid "
                        f"— reasons {report.reasons}")
    manifest.apply_transition(gate2_passed_status(fold), reason=f"gate2 fold{fold} passed",
                              timestamp=timestamp, artifact_hash=report.content_hash())
