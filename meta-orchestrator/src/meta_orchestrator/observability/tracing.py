"""Run metrics computed from the trace (SPEC §15, D2).

Phase 1 keeps a dependency-free structured trace (a list of node events, each carrying
a correlation id + timestamp). This is OpenTelemetry/LangSmith-shaped: each event is a
span-like record. ``build_metrics`` rolls the trace up into the operational metrics the
spec asks for (tokens, cost, calls, retries, decisions).
"""
from __future__ import annotations

from pydantic import BaseModel


class RunMetrics(BaseModel):
    correlation_id: str
    status: str
    passed: bool
    num_nodes: int          # trace span count
    model_calls: int        # generate + synthesize
    tool_calls: int         # Tool Gateway invocations (run_tests, ...)
    verifications: int      # execution self-check + independent verify
    decisions: int          # Decision Engine records
    retries: int            # rounds - 1
    tokens: int
    cost: float


def build_metrics(outcome) -> RunMetrics:
    trace = outcome.trace
    def count(pred) -> int:
        return sum(1 for e in trace if pred(e))

    model_calls = count(lambda e: e.get("node") == "execute" and e.get("react") == "reason→act")
    model_calls += count(lambda e: e.get("node") == "synthesize")
    tool_calls = count(lambda e: e.get("node") == "verify")  # run_tests via Tool Gateway
    verifications = count(lambda e: e.get("node") in ("verify", "independent_verify"))

    return RunMetrics(
        correlation_id=outcome.correlation_id,
        status=outcome.status,
        passed=outcome.passed,
        num_nodes=count(lambda e: "node" in e),
        model_calls=model_calls,
        tool_calls=tool_calls,
        verifications=verifications,
        decisions=len(outcome.decision_records),
        retries=max(0, outcome.rounds - 1),
        tokens=outcome.tokens_spent,
        cost=outcome.cost,
    )
