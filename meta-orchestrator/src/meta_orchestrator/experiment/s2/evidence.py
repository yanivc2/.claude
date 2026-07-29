"""Observation-backed gate predicates (final $0 hardening, refinement 1).

A pure gate that receives ``serialized_body_ok=True`` proves only its own logic, not that the
fact was checked — and wrapping the same boolean in a JSON file changes nothing. So evidence
artifacts here carry RAW OBSERVATIONS (pytest node-ids / exit code / failed / skipped / package
versions; per-count request hash + source), and the gate DERIVES the predicate itself:

    Artifacts contain observations.  The gate derives conclusions.  Never a trusted summary.

Each artifact self-hashes over its observations, so a hand-edited summary that doesn't match the
real observations is rejected. This is corruption/mistake detection inside the run protocol — NOT
defence against an adversary who forges observations and re-hashes them together.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from typing import Optional

from pydantic import BaseModel, Field

from .b1_selector import REAL_SOURCE


class Predicate(BaseModel):
    name: str
    ok: bool
    reasons: list[str] = Field(default_factory=list)


def _self_hash(model: BaseModel, *, exclude: set[str]) -> str:
    payload = {k: v for k, v in model.model_dump().items() if k not in exclude}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


# --- SDK / suite evidence ----------------------------------------------------------------
class PytestEvidence(BaseModel):
    """Raw observations from a suite run — NOT a 'tests_ok' boolean."""

    artifact_type: str = "pytest_report"
    run_id: str
    environment_hash: str
    git_commit: str
    exit_code: int
    failed: int
    skipped: int
    passed_node_ids: list[str] = Field(default_factory=list)
    sdk_version: str = ""
    httpx_version: str = ""
    command_hash: str = ""
    artifact_hash: str = ""

    def compute_hash(self) -> str:
        return _self_hash(self, exclude={"artifact_hash"})

    def sealed(self) -> "PytestEvidence":
        return self.model_copy(update={"artifact_hash": self.compute_hash()})


def verify_pytest_evidence(ev: PytestEvidence, *, run_id: str, environment_hash: str,
                           required_node_ids: list[str]) -> Predicate:
    """The gate derives 'suite passed with 0 skips and every required test ran' from observations."""
    reasons: list[str] = []
    if ev.artifact_hash != ev.compute_hash():
        reasons.append("artifact_hash_mismatch")
    if ev.run_id != run_id:
        reasons.append("run_id_mismatch")
    if ev.environment_hash != environment_hash:
        reasons.append("environment_mismatch")
    if ev.exit_code != 0:
        reasons.append("nonzero_exit_code")
    if ev.failed != 0:
        reasons.append("tests_failed")
    if ev.skipped != 0:
        reasons.append("tests_skipped")           # 0 skips required — the SDK tests must RUN
    if not (ev.sdk_version and ev.httpx_version):
        reasons.append("unpinned_sdk_or_httpx")
    missing = [n for n in required_node_ids if n not in ev.passed_node_ids]
    if missing:
        reasons.append(f"missing_required_tests:{missing}")
    return Predicate(name="sdk_suite", ok=not reasons, reasons=reasons)


# --- count_tokens evidence ---------------------------------------------------------------
class CountEvidence(BaseModel):
    """One count observation. The gate re-derives the request hash and checks the source."""

    canonical_request_hash: str
    counter_source: str
    model: str
    api_version: str = ""
    tokens: int
    round_template: str
    cache_provenance: str = ""


def verify_count_evidence(observations: list[CountEvidence], *, expected_request_hashes: set[str],
                          model: str, context_cap: int) -> Predicate:
    """Gate-derived: every expected request was counted, from the REAL source, under the cap.

    ``expected_request_hashes`` is recomputed by the caller (the gate) from the canonical builder
    over the corpus — so a count for a DIFFERENT request than the one that will be sent is caught.
    """
    reasons: list[str] = []
    seen = {o.canonical_request_hash for o in observations}
    missing = expected_request_hashes - seen
    if missing:
        reasons.append(f"missing_counts:{sorted(missing)[:3]}")
    for o in observations:
        if o.counter_source != REAL_SOURCE:
            reasons.append("count_not_from_anthropic_count_tokens")
            break
    for o in observations:
        if o.model != model:
            reasons.append("count_model_mismatch")
            break
        if o.tokens > context_cap:
            reasons.append("count_over_context_cap")
            break
    return Predicate(name="count_tokens", ok=not reasons, reasons=reasons)


# --- frozen-hash recompute (the gate computes, never trusts all_hashes_match=true) --------
def recompute_frozen_hashes_predicate(manifest_hashes: dict[str, str],
                                      corpus_dir: Optional[str]) -> Predicate:
    from .pilot import collect_frozen_hashes
    live = collect_frozen_hashes(corpus_dir)
    reasons: list[str] = []
    for key, val in live.items():
        if manifest_hashes.get(key) != val:
            reasons.append(f"hash_drift:{key}")
    return Predicate(name="frozen_hashes", ok=not reasons, reasons=reasons)


# --- environment attestation (runtime re-attestation) ------------------------------------
class EnvironmentAttestation(BaseModel):
    git_commit: str
    worktree_clean: bool
    python_version: str
    sdk_version: str
    httpx_version: str
    lockfile_hash: str
    endpoint: str
    contract_hash: str
    canonical_builder_hash: str
    verifier_hash: str
    required_env_vars_present: dict[str, bool] = Field(default_factory=dict)
    # NOTE: secret VALUES are never stored — only presence booleans + hashes.


def attest_environment(*, repo_root: str, endpoint: str = "https://api.anthropic.com",
                       required_env_vars: Optional[list[str]] = None) -> EnvironmentAttestation:
    """Compute a LIVE environment attestation. git must be clean; secret values are never stored."""
    import os
    import platform

    from .pilot import collect_frozen_hashes
    hashes = collect_frozen_hashes(None)
    commit = _git(["rev-parse", "HEAD"], repo_root)
    dirty = bool(_git(["status", "--porcelain"], repo_root))
    lock = ""
    for cand in ("poetry.lock", "requirements.lock", "uv.lock", "requirements.txt"):
        p = os.path.join(repo_root, cand)
        if os.path.exists(p):
            lock = hashlib.sha256(open(p, "rb").read()).hexdigest()[:12]
            break
    return EnvironmentAttestation(
        git_commit=commit, worktree_clean=not dirty, python_version=platform.python_version(),
        sdk_version=_pkg_version("anthropic"), httpx_version=_pkg_version("httpx"),
        lockfile_hash=lock, endpoint=endpoint, contract_hash=hashes["agent_contract"],
        canonical_builder_hash=hashes["canonical_builder"], verifier_hash=hashes["verifier_config"],
        required_env_vars_present={v: (os.environ.get(v) not in (None, ""))
                                   for v in (required_env_vars or [])})


def attestation_matches(expected: EnvironmentAttestation,
                        actual: EnvironmentAttestation) -> Predicate:
    """Runtime re-attestation: any drift between Gate 1 and a later call blocks the call."""
    reasons: list[str] = []
    if not actual.worktree_clean:
        reasons.append("dirty_worktree")
    for field in ("git_commit", "python_version", "sdk_version", "httpx_version", "lockfile_hash",
                  "endpoint", "contract_hash", "canonical_builder_hash", "verifier_hash"):
        if getattr(expected, field) != getattr(actual, field):
            reasons.append(f"drift:{field}")
    for var, present in expected.required_env_vars_present.items():
        if actual.required_env_vars_present.get(var) != present:
            reasons.append(f"env_var_change:{var}")
    return Predicate(name="environment", ok=not reasons, reasons=reasons)


class BudgetEvidence(BaseModel):
    projected_fold_cost: float
    reserve_fraction: float
    available_budget: float


def verify_budget_evidence(ev: BudgetEvidence) -> Predicate:
    reasons: list[str] = []
    if ev.reserve_fraction < 0.20:
        reasons.append("reserve_below_20pct")
    need = ev.projected_fold_cost * (1.0 + ev.reserve_fraction)
    if need > ev.available_budget:
        reasons.append("cost_projection_over_budget")
    return Predicate(name="budget", ok=not reasons, reasons=reasons)


class SnapshotEvidence(BaseModel):
    model_id: str
    available: bool
    retirement_date_iso: str            # from the OFFICIAL model card, checked at runtime
    as_of_date_iso: str


def verify_snapshot_evidence(ev: SnapshotEvidence, *, expected_model: str) -> Predicate:
    reasons: list[str] = []
    if ev.model_id != expected_model:
        reasons.append("snapshot_id_mismatch")
    if not ev.available:
        reasons.append("snapshot_unavailable")
    if ev.retirement_date_iso and ev.as_of_date_iso >= ev.retirement_date_iso:
        reasons.append("snapshot_past_retirement")
    return Predicate(name="snapshot", ok=not reasons, reasons=reasons)


# --- a5: pricing + endpoint binding evidence ---------------------------------------------
class PricingDerivationSample(BaseModel):
    input_tokens: int
    output_tokens: int
    claimed_cost_usd: str               # the projection's own figure, as a Decimal string


class PricingEvidence(BaseModel):
    """Observations proving every cost figure was DERIVED from the frozen pricing artifact."""

    pricing_artifact_hash: str
    input_usd_per_mtok: str
    output_usd_per_mtok: str
    samples: list[PricingDerivationSample] = Field(default_factory=list)


def verify_pricing_evidence(ev: PricingEvidence, *, corpus_dir: Optional[str], expected_model: str,
                            expected_provider: str) -> Predicate:
    """Gate-derived: load the frozen artifact, confirm the hash/prices, and RE-DERIVE each cost."""
    from decimal import Decimal

    from .pricing import call_cost_usd, load_frozen_pricing
    reasons: list[str] = []
    if not corpus_dir:
        return Predicate(name="pricing", ok=False, reasons=["no_corpus_dir"])
    try:
        art = load_frozen_pricing(corpus_dir)
    except Exception as exc:                          # missing / stale-hash / wrong-schema
        return Predicate(name="pricing", ok=False, reasons=[f"artifact_invalid:{str(exc)[:60]}"])
    if ev.pricing_artifact_hash != art.content_hash:
        reasons.append("pricing_hash_mismatch")
    if Decimal(ev.input_usd_per_mtok) != Decimal(art.input_usd_per_mtok):
        reasons.append("input_price_mismatch")
    if Decimal(ev.output_usd_per_mtok) != Decimal(art.output_usd_per_mtok):
        reasons.append("output_price_mismatch")
    if art.model != expected_model:
        reasons.append("pricing_model_mismatch")
    if art.provider != expected_provider:
        reasons.append("pricing_provider_mismatch")
    if not ev.samples:
        reasons.append("no_derivation_samples")
    for s in ev.samples:                              # every claimed cost must re-derive exactly
        want = call_cost_usd(art, input_tokens=s.input_tokens, output_tokens=s.output_tokens)
        if Decimal(s.claimed_cost_usd) != want:
            reasons.append("cost_not_derived_from_artifact")
            break
    return Predicate(name="pricing", ok=not reasons, reasons=reasons)


class EndpointEvidence(BaseModel):
    """The live endpoint attestation (provider/scheme/host/model) resolved from the SDK client."""

    attestation: dict                    # EndpointAttestation.model_dump()


def verify_endpoint_evidence(ev: EndpointEvidence, *, corpus_dir: Optional[str]) -> Predicate:
    """Gate-derived: rebuild the attestation and assert it is the approved endpoint for the price."""
    from .endpoint import EndpointAttestation, assert_endpoint_approved
    from .pricing import load_frozen_pricing
    if not corpus_dir:
        return Predicate(name="endpoint", ok=False, reasons=["no_corpus_dir"])
    try:
        art = load_frozen_pricing(corpus_dir)
        att = EndpointAttestation(**ev.attestation)
        assert_endpoint_approved(att, art)
    except Exception as exc:
        return Predicate(name="endpoint", ok=False, reasons=[f"endpoint_blocked:{str(exc)[:70]}"])
    return Predicate(name="endpoint", ok=True)


class TrainingEvidence(BaseModel):
    fold: int
    outcomes: dict[str, str]            # task_id -> solver_pass | solver_fail | incomplete
    expected_train_ids: list[str]


def verify_training_evidence(ev: TrainingEvidence) -> Predicate:
    terminal = {"solver_pass", "solver_fail"}
    reasons: list[str] = []
    missing = [t for t in ev.expected_train_ids if t not in ev.outcomes]
    if missing:
        reasons.append(f"missing_train_outcomes:{missing[:3]}")
    non_terminal = [t for t in ev.expected_train_ids if ev.outcomes.get(t) not in terminal]
    if non_terminal:
        reasons.append(f"training_incomplete:{non_terminal[:3]}")
    return Predicate(name="training", ok=not reasons, reasons=reasons)


def _aggregate(preds: list[Predicate]) -> list[str]:
    out: list[str] = []
    for p in preds:
        if not p.ok:
            out.extend(f"{p.name}:{r}" for r in (p.reasons or ["failed"]))
    return out


def gate1_from_evidence(*, manifest, corpus_dir: Optional[str], pytest_ev: PytestEvidence,
                        environment_hash: str, required_node_ids: list[str],
                        count_obs: list[CountEvidence], expected_request_hashes: set[str],
                        model: str, context_cap: int, budget_ev: BudgetEvidence,
                        snapshot_ev: SnapshotEvidence,
                        pricing_ev: Optional[PricingEvidence] = None,
                        endpoint_ev: Optional[EndpointEvidence] = None,
                        provider: str = "anthropic", require_pricing_binding: bool = False):
    """PRODUCTION Gate-1 entry: derive every predicate from OBSERVATIONS (no summary booleans).

    a5: when ``require_pricing_binding`` is set (the production path), the frozen-pricing and
    endpoint attestations are MANDATORY — absent ones fail the gate, so no paid call can be
    authorized on cost figures that were not derived from the frozen price at the approved endpoint.
    """
    from .pilot import GateReport
    preds = [
        verify_pytest_evidence(pytest_ev, run_id=manifest.run_id,
                               environment_hash=environment_hash, required_node_ids=required_node_ids),
        verify_count_evidence(count_obs, expected_request_hashes=expected_request_hashes,
                              model=model, context_cap=context_cap),
        recompute_frozen_hashes_predicate(manifest.hashes, corpus_dir),
        verify_budget_evidence(budget_ev),
        verify_snapshot_evidence(snapshot_ev, expected_model=model),
    ]
    pricing_ok = True
    if require_pricing_binding or pricing_ev is not None:
        if pricing_ev is None:
            preds.append(Predicate(name="pricing", ok=False, reasons=["pricing_binding_absent"]))
            pricing_ok = False
        else:
            p = verify_pricing_evidence(pricing_ev, corpus_dir=corpus_dir, expected_model=model,
                                        expected_provider=provider)
            preds.append(p)
            pricing_ok = pricing_ok and p.ok
    if require_pricing_binding or endpoint_ev is not None:
        if endpoint_ev is None:
            preds.append(Predicate(name="endpoint", ok=False, reasons=["endpoint_binding_absent"]))
            pricing_ok = False
        else:
            e = verify_endpoint_evidence(endpoint_ev, corpus_dir=corpus_dir)
            preds.append(e)
            pricing_ok = pricing_ok and e.ok
    reasons = _aggregate(preds)
    production_valid = (bool(count_obs) and all(o.counter_source == REAL_SOURCE for o in count_obs)
                        and pricing_ok)
    source = count_obs[0].counter_source if count_obs else "none"
    return GateReport(gate="gate1", passed=(not reasons and production_valid),
                      production_valid=production_valid, token_count_source=source, reasons=reasons)


def gate2_from_evidence(*, training_ev: TrainingEvidence, b1_selection, active_bank_hash: str,
                        builder_hash_ok: bool, held_out_calls_made: int, all_held_out_fit_cap: bool,
                        budget_ev: BudgetEvidence):
    """PRODUCTION Gate-2 entry: derive predicates; a proxy B1 selection can never pass."""
    from .pilot import GateReport
    reasons: list[str] = _aggregate([verify_training_evidence(training_ev),
                                     verify_budget_evidence(budget_ev)])
    if held_out_calls_made != 0:
        reasons.append("held_out:already_started")
    if not b1_selection.metrics and not b1_selection.mapping:
        reasons.append("b1:no_qualifying_derangement")
    if b1_selection.token_count_source != REAL_SOURCE:
        reasons.append("b1:not_from_anthropic_count_tokens")
    if b1_selection.c_bank_hash != active_bank_hash:
        reasons.append("b1:bank_hash_mismatch")
    if b1_selection.fold != training_ev.fold:
        reasons.append("b1:wrong_fold")
    if not builder_hash_ok:
        reasons.append("b1:builder_hash_mismatch")
    if not all_held_out_fit_cap:
        reasons.append("held_out:over_context_cap")
    production_valid = b1_selection.token_count_source == REAL_SOURCE
    return GateReport(gate="gate2", passed=(not reasons and production_valid),
                      production_valid=production_valid,
                      token_count_source=b1_selection.token_count_source, reasons=reasons)


def _git(args: list[str], cwd: str) -> str:
    try:
        return subprocess.check_output(["git", *args], cwd=cwd, text=True,
                                       stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""


def _pkg_version(name: str) -> str:
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return ""
