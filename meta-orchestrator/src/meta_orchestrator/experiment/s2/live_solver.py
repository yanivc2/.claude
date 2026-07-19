"""Model-backed RoundSolver — the ONE live call path used inside ``run_attempt`` for a real attempt.

It assembles R1/R2 through the single ``canary_prompt`` builder (parity with the counted requests),
wraps EACH paid model call in the full safety sequence, and parses the reply with the strict
``response_parser``:

    PREPARED → assert_call_allowed (a5 pricing+endpoint bound) → GO3 endpoint re-check →
    atomic ledger.reserve(max exposure) → BUDGET_RESERVED → CALL_SENT → complete →
    assert_sent_body_matches (prepared == sent) → CALL_ACKNOWLEDGED → reconcile(actual) →
    COST_RECONCILED → parse → RoundOutput.

A transport failure after CALL_SENT records CALL_AMBIGUOUS_AFTER_SEND and re-raises WITHOUT releasing
the reservation (frozen infra rule). Parse failure is a solver failure (empty patch), never infra.
"""
from __future__ import annotations

import hashlib
import json
from typing import Callable, Optional

from ..lesson import Lesson
from .call_journal import (BUDGET_RESERVED, CALL_ACKNOWLEDGED, CALL_AMBIGUOUS_AFTER_SEND,
                           CALL_PREPARED, CALL_SENT, COST_RECONCILED, BudgetLedger, CallJournal,
                           PreparedRequest, assert_sent_body_matches)
from .canary_prompt import build_r1_user_prompt, build_r2_messages
from .endpoint import EndpointAttestation, assert_endpoint_approved
from .gates import CallContext, assert_call_allowed
from .b1_selector import REAL_SOURCE
from .pricing import PricingArtifact, call_cost_usd, max_call_cost_usd
from .response_parser import parse_model_response
from .solver import RoundOutput, RoundView


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:16]


class ModelBackedRoundSolver:
    """A live RoundSolver. One instance per attempt; ``solve_round`` is called up to 2× by run_attempt."""

    def __init__(self, *, client, statement: str, allowed_source_files: list[str], task_family: str,
                 is_train: bool, pricing: PricingArtifact, endpoint_att: EndpointAttestation,
                 ledger: BudgetLedger, journal: CallJournal, fold: int, condition: str,
                 context_cap: int, count_fn: Callable[[dict], int], run_id: str,
                 env_hash: str, contract_hash: str, active_bank_hash: str, max_model_calls: int = 2,
                 gate1_ok: bool = True, gate2_ok: bool = True, task_id: str = "",
                 execution_grant=None, name: str = "model-backed") -> None:
        self.name = name
        self._c = dict(client=client, statement=statement, allowed=allowed_source_files,
                       family=task_family, is_train=is_train, pricing=pricing, endpoint=endpoint_att,
                       ledger=ledger, journal=journal, fold=fold, condition=condition,
                       context_cap=context_cap, count_fn=count_fn, run_id=run_id, env_hash=env_hash,
                       contract_hash=contract_hash, bank=active_bank_hash, max_calls=max_model_calls,
                       gate1=gate1_ok, gate2=gate2_ok, task_id=task_id, grant=execution_grant)
        self._r1_prompt: Optional[str] = None
        self._assistant_text: str = ""
        self.calls: list[dict] = []                    # per-round accounting for the runner's report
        self._calls_used = 0

    def solve_round(self, view: RoundView) -> RoundOutput:
        c = self._c
        if view.round_index == 1:
            self._r1_prompt = build_r1_user_prompt(c["statement"], view.source, view.memory_lines,
                                                   train=c["is_train"])
            messages = [{"role": "user", "content": self._r1_prompt}]
        else:
            messages = build_r2_messages(self._r1_prompt or "", self._assistant_text,
                                         view.public_feedback or "")

        client = c["client"]
        kwargs = client.build_request_messages(messages)
        outbound_hash = _sha(json.dumps(kwargs, sort_keys=True))
        canonical_hash = _sha(json.dumps({"model": kwargs["model"], "system": kwargs.get("system"),
                                          "messages": messages, "thinking": kwargs.get("thinking")},
                                         sort_keys=True))
        request_tokens = int(c["count_fn"](kwargs))
        call_id = f"{c['run_id']}:f{c['fold']}:{c['condition']}:r{view.round_index}"
        max_exposure = float(max_call_cost_usd(c["pricing"], input_tokens=c["context_cap"],
                                               max_output_tokens=kwargs["max_tokens"]))
        prepared = PreparedRequest(call_id=call_id, fold=c["fold"], condition=c["condition"],
                                   round_index=view.round_index,
                                   canonical_request_hash=canonical_hash,
                                   outbound_body_hash=outbound_hash)

        # P0.5: a live, task-scoped execution grant is required IN ADDITION to Gate 1 (fail-closed).
        grant = c.get("grant")
        grant_present = grant is not None and grant.is_sealed()
        within_grant = grant_present and grant.covers(
            fold=c["fold"], condition=c["condition"], task_id=c["task_id"],
            calls_used=self._calls_used)

        # --- runtime invariant (a5 pricing+endpoint bound) ---
        ctx = CallContext(
            fold=c["fold"], condition=c["condition"], is_held_out=False,
            request_tokens=request_tokens, context_cap=c["context_cap"],
            remaining_budget=c["ledger"].available(), max_call_cost=max_exposure,
            env_hash_expected=c["env_hash"], env_hash_actual=c["env_hash"],
            contract_expected=c["contract_hash"], contract_actual=c["contract_hash"],
            active_bank_hash=c["bank"], model_calls_used=self._calls_used,
            max_model_calls=c["max_calls"], gate1_ok=c["gate1"], gate2_ok=c["gate2"],
            execution_grant_present=grant_present, requested_task_within_grant=within_grant,
            context_cap_source=REAL_SOURCE,
            pricing_artifact_hash_expected=c["pricing"].content_hash,
            pricing_artifact_hash_actual=c["pricing"].content_hash,
            endpoint_hash_expected=c["endpoint"].content_hash,
            endpoint_hash_actual=c["endpoint"].content_hash)
        assert_call_allowed(ctx)
        assert_endpoint_approved(c["endpoint"], c["pricing"])   # GO3: re-check right before send

        j: CallJournal = c["journal"]
        j.record(call_id, CALL_PREPARED, detail={"round": view.round_index,
                                                 "request_tokens": request_tokens})
        c["ledger"].reserve(call_id, max_exposure)
        j.record(call_id, BUDGET_RESERVED, detail={"reserved_usd": max_exposure})
        j.record(call_id, CALL_SENT)
        try:
            resp = client.complete_messages(messages)
        except Exception:
            j.record(call_id, CALL_AMBIGUOUS_AFTER_SEND)       # reservation intentionally NOT released
            raise
        assert_sent_body_matches(prepared, _sha(client.last_request_json))
        j.record(call_id, CALL_ACKNOWLEDGED, detail={"in": resp.input_tokens, "out": resp.output_tokens})
        self._calls_used += 1

        actual_cost = float(call_cost_usd(c["pricing"], input_tokens=resp.input_tokens,
                                          output_tokens=resp.output_tokens))
        c["ledger"].reconcile(call_id, actual_cost)
        j.record(call_id, COST_RECONCILED, detail={"actual_cost_usd": actual_cost})
        self.calls.append({"round": view.round_index, "call_id": call_id,
                           "input_tokens": resp.input_tokens, "output_tokens": resp.output_tokens,
                           "request_tokens_estimate": request_tokens, "actual_cost_usd": actual_cost,
                           "reserved_usd": max_exposure})

        if view.round_index == 1:
            self._assistant_text = resp.text
        parsed = parse_model_response(resp.text, allowed_source_files=c["allowed"],
                                      task_family=c["family"], is_train=c["is_train"])
        return RoundOutput(patch=parsed.patch, candidate_lesson=parsed.candidate_lesson,
                           notes=parsed.reason)
