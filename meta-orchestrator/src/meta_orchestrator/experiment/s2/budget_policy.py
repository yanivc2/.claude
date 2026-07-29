"""Frozen, hash-bound budget POLICY (operator-approved caps) — the single source of the caps.

Distinct from ``pricing`` (the price of a token) and from ``budget_projection`` (the cost of a
plan). This is the operator's approved spending ceiling, content-addressed like the pricing
artifact so any change to a cap changes the hash and thereby invalidates a prior Gate/anchor and
forces a fresh projection + authorization. The pre-Gate-1 ``< $5`` guard is explicitly superseded
and must never be used as a hard cap.

Reported available API credits are NOT part of this policy: they are operator-reported runtime
state (``is_budget_cap: false``), recorded separately by the runner and checked as
``reported_credits >= max_exposure_of_the_next_authorized_block``.
"""
from __future__ import annotations

import hashlib
import json
import os
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel

from .gates import GateError

FROZEN_BUDGET_POLICY_FILENAME = "s2_budget_policy.frozen.json"
BUDGET_POLICY_VERSION = "s2-budget-policy-v2"


class BudgetPolicy(BaseModel):
    policy_version: str
    fold1_hard_cap_usd: str                 # strings → exact Decimal
    global_hard_cap_usd: str
    supersedes: str
    approved_by: str
    approved_at: str
    content_hash: str = ""

    def compute_hash(self) -> str:
        payload = {k: v for k, v in self.model_dump().items() if k != "content_hash"}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    def sealed(self) -> "BudgetPolicy":
        return self.model_copy(update={"content_hash": self.compute_hash()})

    def fold1_cap(self) -> Decimal:
        return Decimal(self.fold1_hard_cap_usd)

    def global_cap(self) -> Decimal:
        return Decimal(self.global_hard_cap_usd)


def build_budget_policy(*, fold1_hard_cap_usd: str, global_hard_cap_usd: str,
                        approved_at: str, approved_by: str = "operator",
                        supersedes: str = "pre-gate-under-5-guard") -> BudgetPolicy:
    return BudgetPolicy(policy_version=BUDGET_POLICY_VERSION, fold1_hard_cap_usd=fold1_hard_cap_usd,
                        global_hard_cap_usd=global_hard_cap_usd, supersedes=supersedes,
                        approved_by=approved_by, approved_at=approved_at).sealed()


def load_frozen_budget_policy(corpus_dir: str) -> BudgetPolicy:
    """Load + verify the frozen budget policy. Blocks on missing / stale-hash / wrong-version."""
    path = os.path.join(corpus_dir, FROZEN_BUDGET_POLICY_FILENAME)
    if not os.path.exists(path):
        raise GateError(f"frozen budget policy missing: {path} — Gate 1 cannot bind a cap")
    pol = BudgetPolicy(**json.load(open(path)))
    if pol.policy_version != BUDGET_POLICY_VERSION:
        raise GateError(f"budget policy version {pol.policy_version!r} != {BUDGET_POLICY_VERSION!r}")
    if pol.content_hash != pol.compute_hash():
        raise GateError("budget policy content_hash mismatch (stale or hand-edited) — Gate 1 void")
    return pol


FROZEN_PAID_SPEND_FILENAME = "s2_paid_spend_ledger.json"
PAID_SPEND_VERSION = "s2-paid-spend-v1"


class PaidSpendLedger(BaseModel):
    """Frozen, hash-bound record of REAL paid spend to date (lifetime), split by kind.

    The GLOBAL hard cap is a lifetime ceiling, so already-spent dollars must count against it —
    the forward projection alone is not enough. The black-112 diagnostic canary ($0.028822 at the
    defective full-file apparatus) is spend that happened; it counts against the global cap and is
    debited from credits, but is NOT official C-training and never advanced the curriculum or bank."""

    schema_version: str = PAID_SPEND_VERSION
    diagnostic_apparatus_spend_usd: str
    official_training_spend_usd: str
    note: str = ""
    content_hash: str = ""

    def compute_hash(self) -> str:
        payload = {k: v for k, v in self.model_dump().items() if k != "content_hash"}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]

    def sealed(self) -> "PaidSpendLedger":
        return self.model_copy(update={"content_hash": self.compute_hash()})

    def total_paid_to_date(self) -> Decimal:
        return Decimal(self.diagnostic_apparatus_spend_usd) + Decimal(self.official_training_spend_usd)


def load_frozen_paid_spend(corpus_dir: str) -> PaidSpendLedger:
    """Load + verify the frozen paid-spend ledger. Blocks on missing / stale-hash / wrong-version."""
    path = os.path.join(corpus_dir, FROZEN_PAID_SPEND_FILENAME)
    if not os.path.exists(path):
        raise GateError(f"frozen paid-spend ledger missing: {path} — Gate 1 cannot bind lifetime spend")
    led = PaidSpendLedger(**json.load(open(path)))
    if led.schema_version != PAID_SPEND_VERSION:
        raise GateError(f"paid-spend ledger version {led.schema_version!r} != {PAID_SPEND_VERSION!r}")
    if led.content_hash != led.compute_hash():
        raise GateError("paid-spend ledger content_hash mismatch (stale or hand-edited) — Gate 1 void")
    return led


class ReportedCredits(BaseModel):
    """Operator-reported API credit balance — runtime state, NOT a policy cap."""

    available_api_credits_usd: str
    source: str = "operator_reported_from_anthropic_console"
    verified_at: str = ""
    machine_verified: bool = False
    is_budget_cap: bool = False

    def amount(self) -> Decimal:
        return Decimal(self.available_api_credits_usd)
