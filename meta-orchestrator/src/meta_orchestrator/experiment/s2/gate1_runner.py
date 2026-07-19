"""Thin Gate-1 evidence runner (adapter) — assembles REAL evidence and feeds the FROZEN gate.

It does NOT re-implement any gate / budget / pricing formula, does NOT decide PASS itself, does NOT
mint an authorization anchor, and NEVER calls ``messages.create``. It:

  1. materialises + hash-verifies each task's buggy source (``materialize``; one mismatch blocks);
  2. builds each task's worst-case R1 (train variant) and R2 requests through the ONE
     ``canary_prompt`` builder + the injected request builder (``S2ModelClient``);
  3. sizes the CONSERVATIVE R1-assistant INPUT envelope by measuring the real ``count_tokens`` delta
     INSIDE the canonical R2 request — minimal units with ``delta >= S2_MAX_TOKENS``, a small frozen
     overshoot bound, and parser validity (a degenerate filler that under-counts is caught);
  4. derives ``context_cap`` from the max real count via the frozen headroom formula (kept separate
     from the 25% budget reserve — two different protections);
  5. projects fold cost via the canonical ``budget_projection`` (100% R2, full 4096 output, 25%);
  6. assembles Pytest / Pricing / Endpoint / Count evidence and calls the frozen
     ``gate1_from_evidence``. The caller reviews the returned report BEFORE any anchor is minted.

``count_fn(kwargs) -> int`` and ``request_builder`` are injected so the whole pipeline is exercised
offline (deterministic fake count) in tests and with the real ``anthropic`` client in the pilot.
"""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field

from .b1_selector import REAL_SOURCE
from .budget_projection import project_fold_cost
from .canary_prompt import (PUBLIC_FEEDBACK_CAP, build_r1_worstcase_prompt, build_r2_messages,
                            max_r1_assistant_envelope)
from .contract_s2 import S2_MAX_TOKENS
from .evidence import (BudgetEvidence, CountEvidence, EndpointEvidence, PricingDerivationSample,
                       PricingEvidence, PytestEvidence, gate1_from_evidence)
from .materialize import materialize_buggy_sources
from .preflight import HEADROOM_FLOOR, HEADROOM_FRACTION, MODEL_TOTAL_CONTEXT
from .pricing import call_cost_usd, load_frozen_pricing
from .response_parser import parse_model_response

# Frozen envelope guard constants.
ENVELOPE_FLOOR = S2_MAX_TOKENS                 # delta must reach the full output allowance
MAX_ENVELOPE_OVERSHOOT = 64                    # minimal-unit search lands within one line's tokens
_MAX_ENVELOPE_UNITS = 4096                     # hard loop bound (never reached in practice)


def _sha(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:16]


def worst_public_feedback() -> str:
    """A deterministic, non-degenerate maximum public-test feedback (capped at PUBLIC_FEEDBACK_CAP)."""
    lines = [f"tests/test_mod.py::test_case_{i} FAILED - assert out_{i} == exp_{i}  # diff at row {i}"
             for i in range(200)]
    return ("\n".join(lines))[:PUBLIC_FEEDBACK_CAP]


class EnvelopeMeasurement(BaseModel):
    task_id: str
    train: bool
    units: int
    r2_empty_tokens: int
    r2_full_tokens: int
    assistant_input_delta: int
    overshoot: int
    parser_valid: bool
    envelope_hash: str
    full_r2_canonical_hash: str


class TaskCount(BaseModel):
    task_id: str
    fold: int
    r1_tokens: int
    r2_tokens: int
    envelope: EnvelopeMeasurement


class Gate1RunArtifact(BaseModel):
    non_authoritative: bool = True
    run_id: str
    git_commit: str
    env_hash: str
    token_count_source: str = REAL_SOURCE
    model: str
    count_model: str
    materialization_cache_index_hash: str
    n_tasks: int
    envelope_generator_hash: str
    envelope_floor: int = ENVELOPE_FLOOR
    max_overshoot_seen: int
    estimated_max_tokens: int
    headroom: int
    context_cap: int
    fits_model_context: bool
    heldout_fold: int
    train_task_ids: list[str]
    projection: dict
    per_task: list[TaskCount] = Field(default_factory=list)
    gate_report: dict
    blocking_notes: list[str] = Field(default_factory=list)


def real_count_fn(anthropic_client) -> Callable[[dict], int]:
    """count_tokens over the request kwargs (drop ``max_tokens`` — the counting endpoint rejects it)."""
    def _count(kwargs: dict) -> int:
        payload = {k: v for k, v in kwargs.items() if k != "max_tokens"}
        resp = anthropic_client.messages.count_tokens(**payload)
        return int(getattr(resp, "input_tokens", None) if hasattr(resp, "input_tokens")
                   else resp["input_tokens"])
    return _count


def _canonical_hash(kwargs: dict, messages: list[dict]) -> str:
    return _sha({"model": kwargs["model"], "system": kwargs.get("system"),
                 "messages": messages, "thinking": kwargs.get("thinking")})


def measure_assistant_delta(request_builder, count_fn, *, r1_prompt: str, feedback: str,
                            assistant_text: str) -> int:
    """The marginal input tokens an ``assistant_text`` adds INSIDE the canonical R2 request.

    This is the correct measurement (not a standalone string count): it is what a degenerate filler
    (e.g. ``"O"*N``) fails — BPE collapses it, so its R2 delta stays below the floor and the guard
    blocks. Used by the negative test that proves the guard catches the under-count.
    """
    base = count_fn(request_builder.build_request_messages(build_r2_messages(r1_prompt, "", feedback)))
    full = count_fn(request_builder.build_request_messages(
        build_r2_messages(r1_prompt, assistant_text, feedback)))
    return full - base


def _size_envelope(request_builder, count_fn, *, task_id: str, r1_prompt: str, feedback: str,
                   allowed: list[str], task_family: str, train: bool,
                   floor: int = ENVELOPE_FLOOR, overshoot_tol: int = MAX_ENVELOPE_OVERSHOOT
                   ) -> EnvelopeMeasurement:
    """Binary-search the SMALLEST envelope whose measured R2 token delta reaches ``floor``."""
    def r2_tokens(units: int) -> tuple[int, str, list[dict]]:
        env = "" if units == 0 else max_r1_assistant_envelope(allowed, train=train, units=units)
        msgs = build_r2_messages(r1_prompt, env, feedback)
        kwargs = request_builder.build_request_messages(msgs)
        return count_fn(kwargs), env, msgs

    base, _, _ = r2_tokens(0)
    # exponential upper bound
    hi = 8
    while True:
        full, _, _ = r2_tokens(hi)
        if full - base >= floor or hi >= _MAX_ENVELOPE_UNITS:
            break
        hi *= 2
    if r2_tokens(hi)[0] - base < floor:
        raise RuntimeError(f"{task_id}: envelope could not reach floor={floor} within {_MAX_ENVELOPE_UNITS} units")
    lo = 1
    while lo < hi:                                     # minimal units with delta >= floor
        mid = (lo + hi) // 2
        if r2_tokens(mid)[0] - base >= floor:
            hi = mid
        else:
            lo = mid + 1
    full, env, msgs = r2_tokens(lo)
    delta = full - base
    parser_valid = parse_model_response(env, allowed_source_files=allowed, task_family=task_family,
                                        is_train=train).ok
    kwargs = request_builder.build_request_messages(msgs)
    return EnvelopeMeasurement(
        task_id=task_id, train=train, units=lo, r2_empty_tokens=base, r2_full_tokens=full,
        assistant_input_delta=delta, overshoot=delta - floor, parser_valid=parser_valid,
        envelope_hash=_sha(env), full_r2_canonical_hash=_canonical_hash(kwargs, msgs))


def _context_cap(estimated_max: int) -> tuple[int, int, bool]:
    headroom = max(HEADROOM_FLOOR, math.ceil(HEADROOM_FRACTION * estimated_max))
    cap = int(math.ceil((estimated_max + headroom) / 1024) * 1024)
    return headroom, cap, (cap + S2_MAX_TOKENS <= MODEL_TOTAL_CONTEXT)


def run_gate1(*, corpus_json_path: str, scope_json_path: str, corpus_dir: str, cache_dir: str,
              request_builder, count_fn: Callable[[dict], int], model: str, count_model: str,
              endpoint_attestation: dict, pytest_ev: PytestEvidence, env_hash: str,
              available_budget_usd: float, run_id: str, git_commit: str,
              required_node_ids: list[str], heldout_fold: int = 1,
              task_ids: Optional[list[str]] = None,
              provider: str = "anthropic") -> Gate1RunArtifact:
    """Assemble real Gate-1 evidence and evaluate the FROZEN gate. Authorises nothing."""
    blocking: list[str] = []

    generator_hash = _sha(max_r1_assistant_envelope(["a/b.py"], train=True, units=3))  # frozen shape

    # (1) materialise + hash-verify buggy sources — ONE mismatch blocks the whole run (no gate).
    sources, mat = materialize_buggy_sources(corpus_json_path, cache_dir, task_ids=task_ids)
    if not mat.all_verified:
        blocking.append(f"materialization_unverified:{mat.mismatches[:3]}")
        return Gate1RunArtifact(
            run_id=run_id, git_commit=git_commit, env_hash=env_hash, model=model,
            count_model=count_model, materialization_cache_index_hash=mat.cache_index_hash,
            n_tasks=0, envelope_generator_hash=generator_hash, max_overshoot_seen=0,
            estimated_max_tokens=0, headroom=0, context_cap=0, fits_model_context=False,
            heldout_fold=heldout_fold, train_task_ids=[], projection={},
            gate_report={"gate": "gate1", "passed": False, "production_valid": False,
                         "token_count_source": "none",
                         "reasons": ["materialization_unverified"]},
            blocking_notes=blocking)

    corpus = json.load(open(corpus_json_path))["tasks"]
    scope = {t["task_id"]: t for t in json.load(open(scope_json_path))["tasks"]}
    ids = task_ids if task_ids is not None else list(sources)
    feedback = worst_public_feedback()

    per_task: list[TaskCount] = []
    count_obs: list[CountEvidence] = []
    estimated_max = 0
    max_overshoot = 0

    for tid in ids:
        if tid not in sources:                        # unverified source → cannot count faithfully
            continue
        statement = corpus[tid]["sanitized_statement"]
        allowed = sorted(corpus[tid]["allowed_source_files"])
        family = corpus[tid].get("family", "unknown")
        fold = scope[tid]["fold"]
        # worst case for BOTH the cap and fold-train is the TRAIN variant (carries the lesson schema)
        r1_prompt = build_r1_worstcase_prompt(statement, sources[tid], train=True)
        r1_msgs = [{"role": "user", "content": r1_prompt}]
        r1_kwargs = request_builder.build_request_messages(r1_msgs)
        r1_tokens = count_fn(r1_kwargs)
        env = _size_envelope(request_builder, count_fn, task_id=tid, r1_prompt=r1_prompt,
                             feedback=feedback, allowed=allowed, task_family=family, train=True)
        if not env.parser_valid:
            blocking.append(f"{tid}:envelope_parser_invalid")
        if env.assistant_input_delta < ENVELOPE_FLOOR:
            blocking.append(f"{tid}:assistant_delta_below_floor")
        if env.overshoot > MAX_ENVELOPE_OVERSHOOT:
            blocking.append(f"{tid}:envelope_overshoot>{MAX_ENVELOPE_OVERSHOOT}")
        max_overshoot = max(max_overshoot, env.overshoot)
        r2_tokens = env.r2_full_tokens
        estimated_max = max(estimated_max, r1_tokens, r2_tokens)
        per_task.append(TaskCount(task_id=tid, fold=fold, r1_tokens=r1_tokens, r2_tokens=r2_tokens,
                                  envelope=env))
        r1_hash = _canonical_hash(r1_kwargs, r1_msgs)
        count_obs.append(CountEvidence(canonical_request_hash=r1_hash, counter_source=REAL_SOURCE,
                                       model=model, tokens=r1_tokens, round_template="R1"))
        count_obs.append(CountEvidence(canonical_request_hash=env.full_r2_canonical_hash,
                                       counter_source=REAL_SOURCE, model=model, tokens=r2_tokens,
                                       round_template="R2"))

    headroom, context_cap, fits = _context_cap(estimated_max)
    if not fits:
        blocking.append("context_cap_plus_output_exceeds_model_context")

    # (5) fold-1 projection: train = tasks NOT in the held-out fold
    train_tasks = [t for t in per_task if t.fold != heldout_fold]
    proj = project_fold_cost(load_frozen_pricing(corpus_dir), fold=heldout_fold,
                             r1_input_tokens=[t.r1_tokens for t in train_tasks],
                             r2_input_tokens=[t.r2_tokens for t in train_tasks])
    budget_ev = proj.to_budget_evidence(available_budget_usd)

    # (6) pricing + endpoint evidence (production binding)
    pricing = load_frozen_pricing(corpus_dir)
    samples = [PricingDerivationSample(
        input_tokens=context_cap, output_tokens=S2_MAX_TOKENS,
        claimed_cost_usd=format(call_cost_usd(pricing, input_tokens=context_cap,
                                              output_tokens=S2_MAX_TOKENS), "f"))]
    pricing_ev = PricingEvidence(pricing_artifact_hash=pricing.content_hash,
                                 input_usd_per_mtok=pricing.input_usd_per_mtok,
                                 output_usd_per_mtok=pricing.output_usd_per_mtok, samples=samples)
    endpoint_ev = EndpointEvidence(attestation=endpoint_attestation)

    from .pilot import build_run_manifest
    manifest = build_run_manifest(run_id, git_commit, budget_usd=available_budget_usd,
                                  corpus_dir=corpus_dir)
    expected_hashes = {o.canonical_request_hash for o in count_obs}
    report = gate1_from_evidence(
        manifest=manifest, corpus_dir=corpus_dir, pytest_ev=pytest_ev, environment_hash=env_hash,
        required_node_ids=required_node_ids, count_obs=count_obs,
        expected_request_hashes=expected_hashes, model=model, context_cap=context_cap,
        budget_ev=budget_ev, snapshot_ev=_snapshot_ev(model), pricing_ev=pricing_ev,
        endpoint_ev=endpoint_ev, provider=provider, require_pricing_binding=True)

    return Gate1RunArtifact(
        run_id=run_id, git_commit=git_commit, env_hash=env_hash, model=model, count_model=count_model,
        materialization_cache_index_hash=mat.cache_index_hash, n_tasks=len(per_task),
        envelope_generator_hash=generator_hash, max_overshoot_seen=max_overshoot,
        estimated_max_tokens=estimated_max, headroom=headroom, context_cap=context_cap,
        fits_model_context=fits, heldout_fold=heldout_fold,
        train_task_ids=[t.task_id for t in train_tasks], projection=proj.model_dump(),
        per_task=per_task, gate_report=report.model_dump(), blocking_notes=blocking)


def _snapshot_ev(model: str):
    """Haiku 4.5 is Active with NO confirmed retirement date (official model card). We record the
    conservative fact — never a hard retirement date from a "not sooner than" boundary."""
    from .evidence import SnapshotEvidence
    return SnapshotEvidence(model_id=model, available=True, retirement_date_iso="",
                            as_of_date_iso="2026-07-19")
