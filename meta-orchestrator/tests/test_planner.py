"""C1: Planner decomposes into a task graph with correct dependency ordering."""
from __future__ import annotations

import pytest

from meta_orchestrator.planner.planner import Plan, SubTask, plan_seed_task, topological_levels
from meta_orchestrator.seed_task.corpus import get_case


def test_seed_plan_is_a_graph_with_dependencies():
    plan = plan_seed_task(get_case("off_by_one_sum"))
    ids = {s.id for s in plan.subtasks}
    assert {"analyze_signature", "analyze_tests", "generate_fix", "verify_fix"} <= ids
    # generate depends on both analyses
    assert set(plan.by_id("generate_fix").deps) == {"analyze_signature", "analyze_tests"}


def test_topological_levels_parallel_then_serial():
    plan = plan_seed_task(get_case("off_by_one_sum"))
    levels = topological_levels(plan)
    # the two independent analyses share the first (parallelisable) level
    assert set(levels[0]) == {"analyze_signature", "analyze_tests"}
    # generate precedes verify
    assert levels.index(["generate_fix"]) < levels.index(["verify_fix"])


def test_cycle_is_detected():
    plan = Plan(subtasks=[
        SubTask(id="a", kind="analyze", description="", deps=["b"]),
        SubTask(id="b", kind="analyze", description="", deps=["a"]),
    ])
    with pytest.raises(ValueError):
        topological_levels(plan)
