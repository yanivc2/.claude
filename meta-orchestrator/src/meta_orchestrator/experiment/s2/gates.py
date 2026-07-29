"""Pilot gate checks (P0.3) + the per-call runtime invariant (P0.4).

Human authorization is split into Gate 1 (before paid C-training) and Gate 2 (after the bank is
frozen, before held-out). But a human gate is a point-in-time check; a runtime bug can still build
an illegal request afterward. ``assert_call_allowed`` is the machine-enforced invariant checked
before EVERY paid Messages call: a preflight proves the legal DESIGN fits; this proves the ACTUAL
request is legal. Any violation blocks the call (never truncates, never falls back).
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel

from .b1_selector import REAL_SOURCE, B1Selection
from .gate_error import GateError  # noqa: F401 — re-exported; canonical definition is the leaf module
from .preflight import ContextCapReport


# --- Gate 2 training completeness (P0.3) -------------------------------------------------
_TERMINAL = {"solver_pass", "solver_fail"}


def assert_training_complete(train_outcomes: dict[str, str], expected_train_ids: list[str]) -> None:
    """A bank may open held-out ONLY if all train tasks reached a terminal, non-infra state.

    A bank learned from 15/18 tasks because 3 hit unresolved infrastructure errors is NOT the
    pre-registered treatment. Absent a pre-frozen partial-training rule, this blocks.
    """
    missing = [t for t in expected_train_ids if t not in train_outcomes]
    if missing:
        raise GateError(f"training outcomes missing for {missing}")
    non_terminal = [t for t in expected_train_ids if train_outcomes[t] not in _TERMINAL]
    if non_terminal:
        raise GateError(
            f"training not complete for {non_terminal} (unresolved infrastructure missingness); "
            "block held-out — no partial-training bank without a pre-frozen rule.")


# --- production-validity guards ----------------------------------------------------------
def assert_context_cap_production_valid(report: ContextCapReport) -> None:
    if report.token_count_source != REAL_SOURCE:
        raise GateError(
            f"context_cap token_count_source={report.token_count_source!r}; a production cap "
            f"requires {REAL_SOURCE!r} (a proxy dry-run cannot freeze the live cap).")
    if not report.fits_model_context:
        raise GateError("context_cap + max_tokens exceeds the model context window")
    if report.over_cap_tasks:
        raise GateError(f"tasks exceed context_cap: {report.over_cap_tasks} — decide + re-version "
                        "the manifest; never truncate target source.")


def assert_b1_selection_production_valid(selection: B1Selection, *, bank_hash: str,
                                         fold: int) -> None:
    if selection.token_count_source != REAL_SOURCE:
        raise GateError(f"B1 selection token_count_source={selection.token_count_source!r}; "
                        f"a production mapping requires {REAL_SOURCE!r} (not the proxy pick).")
    if selection.fold != fold:
        raise GateError(f"B1 selection is for fold {selection.fold}, not fold {fold} "
                        "(a fold's mapping can never authorize another fold).")
    if selection.c_bank_hash != bank_hash:
        raise GateError("B1 mapping is bound to a DIFFERENT bank hash than the active bank "
                        "(stale mapping — the bank changed after selection).")


# --- per-call runtime invariant (P0.4) ---------------------------------------------------
class CallContext(BaseModel):
    fold: int
    condition: str
    is_held_out: bool
    request_tokens: int
    context_cap: int
    remaining_budget: float
    max_call_cost: float
    env_hash_expected: str
    env_hash_actual: str
    contract_expected: str
    contract_actual: str
    active_bank_hash: str
    b1_mapping_bank_hash: Optional[str] = None      # required for held-out B1 calls
    b1_source: Optional[str] = None                  # token_count_source of the active B1 mapping
    model_calls_used: int
    max_model_calls: int
    gate1_ok: bool
    gate2_ok: bool                                    # required True for held-out calls
    context_cap_source: str                          # must be REAL_SOURCE for a paid call
    # execution grant (P0.5): a SECOND, narrow authorization required IN ADDITION to the Gate-1
    # anchor. A passed Gate 1 proves the DESIGN is fundable; it must NOT by itself open spending.
    # Every paid call also requires a live, task-scoped execution grant. Defaults are fail-CLOSED:
    # an anchor without a matching grant blocks every messages.create.
    execution_grant_present: bool = False            # a live execution grant exists
    requested_task_within_grant: bool = False        # this fold/condition/task is inside its scope
    # a5 pricing + endpoint binding: hashes are compared as primitives here (the artifacts are
    # resolved upstream), so this module stays dependency-free and cannot import a cycle.
    pricing_artifact_hash_expected: str = ""          # the price Gate 1 was authorized under
    pricing_artifact_hash_actual: str = ""            # the live frozen-pricing hash at call time
    endpoint_hash_expected: str = ""                  # the approved endpoint attestation
    endpoint_hash_actual: str = ""                    # the live endpoint attestation at call time


def assert_call_allowed(ctx: CallContext) -> None:
    """The invariant checked before every paid Messages request. Blocks on ANY violation."""
    if not ctx.gate1_ok:
        raise GateError("Gate 1 not satisfied")
    # P0.5: a passed Gate 1 authorizes the DESIGN, never spending. A live, task-scoped execution
    # grant is required for EVERY paid call; without it (or outside its scope) the call is blocked.
    if not ctx.execution_grant_present:
        raise GateError("no execution grant — Gate 1 authorizes the design, not spending; a separate "
                        "task-scoped execution grant is required before any messages.create")
    if not ctx.requested_task_within_grant:
        raise GateError("requested fold/condition/task is outside the active execution grant scope")
    if ctx.env_hash_actual != ctx.env_hash_expected:
        raise GateError("environment hash mismatch (SDK/config changed since the gate)")
    if ctx.contract_actual != ctx.contract_expected:
        raise GateError("agent-contract snapshot mismatch")
    if ctx.context_cap_source != REAL_SOURCE:
        raise GateError("context_cap came from a non-production (proxy) source")
    # a5: a silent price change or an endpoint/gateway swap must block, not proceed on the old
    # estimate. Both hashes are bound into the authorization anchor's evidence bundle.
    if not ctx.pricing_artifact_hash_expected or not ctx.pricing_artifact_hash_actual:
        raise GateError("pricing artifact hash not bound to this call (a5 binding absent)")
    if ctx.pricing_artifact_hash_actual != ctx.pricing_artifact_hash_expected:
        raise GateError("pricing artifact hash drift since Gate 1 — re-project and re-authorize")
    if not ctx.endpoint_hash_expected or not ctx.endpoint_hash_actual:
        raise GateError("endpoint attestation not bound to this call (a5 binding absent)")
    if ctx.endpoint_hash_actual != ctx.endpoint_hash_expected:
        raise GateError("endpoint changed since Gate 1 (base_url / gateway / model) — re-authorize")
    if ctx.request_tokens > ctx.context_cap:
        raise GateError(f"request {ctx.request_tokens} tok > frozen context_cap {ctx.context_cap} "
                        "— block, do not truncate or send")
    if ctx.remaining_budget < ctx.max_call_cost:
        raise GateError("remaining budget below the maximum authorized call exposure")
    if ctx.model_calls_used >= ctx.max_model_calls:
        raise GateError("attempt model-call cap already reached")
    if ctx.is_held_out:
        if not ctx.gate2_ok:
            raise GateError("Gate 2 not satisfied for a held-out call")
        if ctx.b1_source != REAL_SOURCE:
            raise GateError("held-out call references a non-production B1 mapping (proxy artifact)")
        if ctx.b1_mapping_bank_hash != ctx.active_bank_hash:
            raise GateError("B1 mapping bank hash != active bank hash (stale/cross-fold artifact)")
