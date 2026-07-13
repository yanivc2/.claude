"""Planner (SPEC §12).

Plan-then-execute: decompose the task into sub-tasks with dependencies (a task graph).
Independent sub-tasks share a topological "level" and may run in parallel; dependent
ones run in order. Within a sub-task the executor does a ReAct micro-step (reason→act).
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from ..seed_task.definition import BugCase


class SubTask(BaseModel):
    id: str
    description: str
    kind: str                       # analyze | generate | verify | synthesize
    deps: list[str] = Field(default_factory=list)


class Plan(BaseModel):
    subtasks: list[SubTask]

    def by_id(self, sid: str) -> SubTask:
        for s in self.subtasks:
            if s.id == sid:
                return s
        raise KeyError(sid)


def plan_seed_task(case: BugCase) -> Plan:
    """Task graph for the code-fix seed task.

    Two independent analysis sub-tasks (parallelisable), then generate (depends on
    both), then verify (depends on generate). Small but genuinely a graph, not a line.
    """
    return Plan(
        subtasks=[
            SubTask(id="analyze_signature", kind="analyze",
                    description=f"Inspect the failing API of {case.module_filename}."),
            SubTask(id="analyze_tests", kind="analyze",
                    description="Read the pytest suite to learn the expected behaviour."),
            SubTask(id="generate_fix", kind="generate",
                    description="Produce a corrected module.",
                    deps=["analyze_signature", "analyze_tests"]),
            SubTask(id="verify_fix", kind="verify",
                    description="Run the tests against the candidate.",
                    deps=["generate_fix"]),
        ]
    )


def topological_levels(plan: Plan) -> list[list[str]]:
    """Group sub-task ids into dependency levels (each level is parallelisable)."""
    remaining = {s.id: set(s.deps) for s in plan.subtasks}
    done: set[str] = set()
    levels: list[list[str]] = []
    while remaining:
        ready = sorted(sid for sid, deps in remaining.items() if deps <= done)
        if not ready:
            raise ValueError("cycle detected in plan dependencies")
        levels.append(ready)
        done |= set(ready)
        for sid in ready:
            del remaining[sid]
    return levels
