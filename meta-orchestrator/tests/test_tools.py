"""C2: Tool Gateway permission tiers — read-only runs alone, HIGH needs approval."""
from __future__ import annotations

import pytest

from meta_orchestrator.seed_task.corpus import get_case
from meta_orchestrator.tools.gateway import ApprovalRequiredError, default_tool_gateway


def test_read_only_tool_runs_without_approval():
    gw = default_tool_gateway()
    out = gw.invoke("search", {"query": "anything"})  # no approver needed
    assert out["results"] == []


def test_low_tier_run_tests_runs_without_approval():
    gw = default_tool_gateway()
    case = get_case("off_by_one_sum")
    res = gw.invoke("run_tests", {"case": case, "candidate_source": case.reference_fix})
    assert res.passed is True


def test_high_impact_tool_blocks_without_approval():
    gw = default_tool_gateway()
    with pytest.raises(ApprovalRequiredError):
        gw.invoke("persist_artifact", {"path": "solution.py"})  # no approver → blocked


def test_high_impact_tool_runs_when_approved():
    gw = default_tool_gateway()
    out = gw.invoke("persist_artifact", {"path": "solution.py"}, approver=lambda name, args: True)
    assert out["persisted"] is True
    # audit records the approved high-impact call
    assert gw.audit[-1]["approved"] is True
    assert gw.audit[-1]["tier"] == 3


def test_high_impact_denied_is_audited_and_raises():
    gw = default_tool_gateway()
    with pytest.raises(ApprovalRequiredError):
        gw.invoke("persist_artifact", {}, approver=lambda name, args: False)
    assert gw.audit[-1]["approved"] is False
