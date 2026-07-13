"""D2: correlation-ID trace + operational metrics."""
from __future__ import annotations

from meta_orchestrator.orchestrator.orchestrator import Orchestrator
from meta_orchestrator.seed_task.corpus import get_case


def test_metrics_and_correlation_id(booted):
    store, registry, config = booted
    orch = Orchestrator(store, registry, config)
    out = orch.run(get_case("off_by_one_sum"), run_id="obs", correlation_id="corr-123")

    assert out.correlation_id == "corr-123"
    m = out.metrics
    assert m is not None
    assert m.correlation_id == "corr-123"
    assert m.model_calls >= 2       # generate + synthesize
    assert m.tool_calls >= 1        # run_tests via Tool Gateway
    assert m.verifications >= 2     # execution self-check + independent verify
    assert m.decisions >= 1         # Decision Engine record(s)
    assert m.tokens > 0 and m.cost > 0

    # every trace span carries the correlation id
    assert all(e.get("corr") == "corr-123" for e in out.trace if "node" in e)
