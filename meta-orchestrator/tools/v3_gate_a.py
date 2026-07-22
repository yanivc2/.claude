"""V3 Gate-A — output-contract qualification runner (stateless; NO memory / banking / lessons).

Engineering qualification, NOT a memory-benefit test. Each held-out task is run under two output
contracts, memory disabled in both:
    OLD = frozen v2.2 SEARCH/REPLACE contract (response_parser + realtask.apply_patch)
    NEW = v3 JSON unique-anchor contract (v3_output_contract_prototype)
Everything else is identical: same model (claude-haiku-4-5-20251001), thinking budget 1024,
max_tokens 11264, same context/materialization/public+hidden tests, same round lifecycle. ONLY
the output contract varies. thinking is NOT changed in Gate A (a thinking-off study is a separate
future gate) — so any delta is attributable to the contract, not to thinking.

Primary metric per cell: VALID_APPLIED_PATCH (complete + schema-valid + anchors resolve uniquely
+ edits apply atomically + files still parse). Public/hidden solve is secondary. This module is
import-safe and decodes/sends nothing on import; the bank / write-gate / lesson-writer are never
imported, so a bank write is structurally impossible.
"""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
from decimal import Decimal
from typing import Optional

from meta_orchestrator.experiment.s2 import realtask as RT
from meta_orchestrator.experiment.s2.call_journal import BudgetLedger
from meta_orchestrator.experiment.s2.canary_prompt import build_r1_user_prompt
from meta_orchestrator.experiment.s2.execution_grant import GrantUsageLedger
from meta_orchestrator.experiment.s2.pricing import call_cost_usd
from meta_orchestrator.experiment.s2.response_parser import parse_model_response
from meta_orchestrator.experiment.s2.heldout_eval import SealedOutcomeStore

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "v3_output_contract_prototype", os.path.join(_HERE, "v3_output_contract_prototype.py"))
V3C = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(V3C)

EVAL_MODEL = "claude-haiku-4-5-20251001"
THINKING_BUDGET = 1024
MAX_TOKENS = 11264
GATE_A_PHASE = "v3_gate_a"
CONTRACTS = ["OLD", "NEW"]

# terminal valid/invalid states (superset of the two parsers' vocabularies)
VALID_APPLIED = "VALID_APPLIED_PATCH"

NEW_CONTRACT_INSTRUCTIONS = (
    "# Output format\n"
    "Return ONLY a single JSON object, optionally in one ```json fenced block, of the form:\n"
    '{"edits": [{"anchor": "<a substring that occurs EXACTLY ONCE in the file above>", '
    '"replacement": "<text that replaces the anchor>"}], "done": true}\n'
    "Rules: each anchor must appear exactly once in the source; keep anchors short but unique; "
    "replacement is the exact new text; include \"done\": true as the final key to signal a "
    "complete reply; edit only the given source file(s); do not modify tests or evaluation logic. "
    "If multiple files are editable, add \"file\": \"<path>\" to each edit."
)


def build_prompt(contract: str, statement: str, source: dict, feedback: Optional[str] = None) -> str:
    """OLD reuses the frozen v2.2 non-train R1 prompt; NEW swaps in the JSON-contract instructions."""
    if contract == "OLD":
        base = build_r1_user_prompt(statement, source, [], train=False)   # memory disabled → []
    elif contract == "NEW":
        parts = ["# Task",
                 "Repair the given source file(s) so the hidden test suite passes. Modify only the "
                 "given source file(s); do not edit tests or evaluation logic.",
                 f"# Problem\n{statement}", "# Source files"]
        for path in sorted(source):
            parts.append(f"## {path}\n{source[path]}")
        parts.append(NEW_CONTRACT_INSTRUCTIONS)
        base = "\n".join(parts)
    else:
        raise ValueError(f"unknown contract {contract!r}")
    if feedback:
        base += "\n# Previous public test output\n" + feedback
    return base


def _files_parse(ctx) -> bool:
    """Structural validation: every allowed .py source still parses after applying edits."""
    for f in ctx.allowed_source_files:
        p = os.path.join(ctx.repo, f)
        if f.endswith(".py") and os.path.exists(p):
            try:
                ast.parse(open(p).read())
            except SyntaxError:
                return False
    return True


def parse_and_apply(contract: str, text: str, ctx) -> tuple[str, bool]:
    """Return (terminal_state, valid_applied). Fail-closed, all-or-none, no partial write."""
    if contract == "OLD":
        pr = parse_model_response(text, allowed_source_files=list(ctx.allowed_source_files),
                                  task_family=ctx.task_family, is_train=False)
        if not pr.ok:
            return f"OLD_{pr.reason.split(':')[0]}", False
        try:
            RT.apply_patch(ctx, pr.edits)
        except Exception as exc:
            RT.reset_allowed_to_buggy(ctx)
            return f"OLD_APPLY_{getattr(exc, 'code', 'FAIL')}", False
    else:
        try:
            doc = V3C.parse_edits(text)
        except V3C.ContractError as e:
            return f"NEW_{e.state}", False
        allowed = list(ctx.allowed_source_files)
        by_file: dict[str, list] = {}
        for ed in doc["edits"]:
            f = ed["file"] or (allowed[0] if len(allowed) == 1 else None)
            if f is None or f not in allowed:
                return "NEW_FILE_UNRESOLVED", False
            by_file.setdefault(f, []).append(ed)
        try:
            staged = {}
            for f, eds in by_file.items():
                staged[f] = V3C.apply_edits(ctx.buggy_source[f], eds)   # raises fail-closed
        except V3C.ContractError as e:
            return f"NEW_{e.state}", False
        for f, content in staged.items():                              # all-or-none write
            open(os.path.join(ctx.repo, f), "w").write(content)
    if not _files_parse(ctx):
        RT.reset_allowed_to_buggy(ctx)
        return f"{contract}_POST_APPLY_SYNTAX_ERROR", False
    return VALID_APPLIED, True


def assert_model_identity(builder, pricing) -> None:
    body = builder.build_request_messages([{"role": "user", "content": "preflight"}])
    ok = (pricing.model == EVAL_MODEL and body.get("model") == EVAL_MODEL
          and body.get("max_tokens") == MAX_TOKENS
          and (body.get("thinking") or {}).get("budget_tokens") == THINKING_BUDGET)
    if not ok:
        raise RuntimeError(f"MODEL_IDENTITY_DRIFT: {body.get('model')} tok={body.get('max_tokens')} "
                           f"think={body.get('thinking')}")


def run_gate_a_cell(ctx, *, client, contract: str, statement: str, pricing, grant,
                    grant_ledger_path: str, work_dir: str, full_exposure_usd: str,
                    fold_budget_usd: float, store: SealedOutcomeStore, cell_index: int,
                    rep: int = 0) -> dict:
    """One Gate-A cell on the ONE paid path (memory disabled). Reservation → grant-consumed R1
    (→ R2 only on genuine public FAIL) → parse+apply per contract → hidden verify → reconcile →
    mark grant complete → sealed record. NO memory, NO banking, NO lesson-writer."""
    if grant.phase != GATE_A_PHASE:
        raise RuntimeError(f"grant phase {grant.phase!r} != {GATE_A_PHASE!r}")
    if grant.curriculum_position != cell_index or grant.task_id != ctx.task_id:
        raise RuntimeError("grant not bound to this cell")
    os.makedirs(work_dir, exist_ok=True)
    budget = BudgetLedger(os.path.join(work_dir, "ledger.json"), total_budget=fold_budget_usd)
    ledger = GrantUsageLedger(grant_ledger_path)
    res_id = f"gatea:{cell_index}"
    budget.reserve(res_id, float(Decimal(full_exposure_usd)))

    RT.reset_allowed_to_buggy(ctx)
    RT.assert_allowed_source_is_buggy(ctx)
    calls: list[dict] = []
    feedback = None
    state, valid_applied, round2, public = None, False, False, "N/A"
    for rnd in (1, 2):
        if rnd == 2:
            if not (state == VALID_APPLIED and public == "FAIL"):
                break
            round2 = True
            RT.reset_allowed_to_buggy(ctx)
            RT.assert_allowed_source_is_buggy(ctx)
            valid_applied = False
        prompt = build_prompt(contract, statement, dict(ctx.buggy_source), feedback)
        ledger.authorize_and_record(grant, fold=grant.fold, condition=grant.condition,
                                    task_id=ctx.task_id)
        resp = client.complete_messages([{"role": "user", "content": prompt}])
        cost = float(call_cost_usd(pricing, input_tokens=resp.input_tokens,
                                   output_tokens=resp.output_tokens))
        calls.append({"round": rnd, "input_tokens": resp.input_tokens,
                      "output_tokens": resp.output_tokens, "actual_cost_usd": f"{cost:.8f}"})
        state, valid_applied = parse_and_apply(contract, resp.text, ctx)
        if not valid_applied:
            public = "N/A"
            break
        pub = RT.run_public_tests(ctx)
        public = pub.status
        if public != "FAIL":
            break
        feedback = pub.sanitized_summary[:2000]

    hidden = RT.hidden_verify(ctx) if valid_applied else None
    total = float(sum(Decimal(c["actual_cost_usd"]) for c in calls))
    budget.reconcile(res_id, total)
    ledger.mark_complete(grant)

    report = {"task_id": ctx.task_id, "contract": contract, "cell_index": cell_index,
              "terminal_state": state, "valid_applied_patch": valid_applied,
              "hidden_verdict": hidden, "round2_opened": round2, "calls_sent": len(calls),
              "per_call": calls, "public_status": public, "memory": "DISABLED",
              "banking": "DISABLED"}
    sealed = store.record(report, task_id=ctx.task_id, condition="A", rep=rep,
                          visible={"cost_usd": f"{total:.8f}", "calls_sent": len(calls),
                                   "infra_status": "ok", "grant_completed": True})
    return {"cell_index": cell_index, "task_id": ctx.task_id, "contract": contract,
            "calls_sent": len(calls), "cost_usd": f"{total:.8f}",
            "sealed_seq": sealed["seq"], "sealed_entry_hash": sealed["entry_hash"]}


def build_gate_a_manifest(task_family: dict, *, bank_bound: bool = False) -> dict:
    """9 tasks × {OLD,NEW} = 18 cells. Balanced first-contract order: alternate which contract
    runs first per task (by sorted index parity), outcome-independent + deterministic."""
    tasks = sorted(task_family)
    cells, idx = [], 0
    for i, t in enumerate(tasks):
        order = ["OLD", "NEW"] if i % 2 == 0 else ["NEW", "OLD"]
        for contract in order:
            cells.append({"cell_index": idx, "task_id": t, "task_family": task_family[t],
                          "contract": contract, "condition": "A", "rep": 0})
            idx += 1
    man = {"manifest_version": "v3-gate-a-manifest-v1", "experiment": "V3_GATE_A_OUTPUT_CONTRACT",
           "purpose": "engineering qualification, not memory-benefit evaluation",
           "model": EVAL_MODEL, "thinking_budget": THINKING_BUDGET, "max_tokens": MAX_TOKENS,
           "memory": "DISABLED", "banking": "DISABLED", "lesson_writer": "DISABLED",
           "tasks": task_family, "n_tasks": len(tasks), "cells": cells, "cell_count": len(cells),
           "contracts": CONTRACTS}
    man["content_hash"] = hashlib.sha256(
        json.dumps(man, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]
    return man
