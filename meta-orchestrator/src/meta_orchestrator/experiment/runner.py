"""Controlled runner (v2 §5) — one measured run, end to end.

    task → frozen contract → fixed tool contract → sandbox → composite verifier → event log

Condition-aware (A/B/C/D) but LEARNING WRITES ARE OFF in Pilot-0: a proposed lesson is
*validated* (and rejected if it leaks/replays) but never promoted, and the verifier is
always the fixed one from verifier.py. This qualifies the machine without asserting learning.
"""
from __future__ import annotations

import uuid
from typing import Optional

from pydantic import BaseModel, Field

from .agent import AgentTools, MeasuredAgent, TaskView
from .artifacts import ArtifactStore
from .contract import AgentContract
from .lesson import LessonRejected
from .sandbox import Sandbox
from .store import EventLog, EventType, ExperimentDB, LessonStore, RunStore
from .task import ExperimentTask
from .verifier import Verdict, verify


class RunResult(BaseModel):
    run_id: str
    condition: str
    passed: bool
    failing_gate: Optional[str]
    verdict: Verdict
    tool_calls: int
    blocked_attempts: list = Field(default_factory=list)
    lesson_accepted: bool = False
    lesson_rejected: bool = False
    claimed_success: bool = False


class ControlledRunner:
    def __init__(self, db: ExperimentDB, artifacts: ArtifactStore) -> None:
        self.db = db
        self.events = EventLog(db)
        self.runs = RunStore(db)
        self.lessons = LessonStore(db)
        self.artifacts = artifacts

    def run(
        self,
        task: ExperimentTask,
        condition: str,
        agent: MeasuredAgent,
        contract: AgentContract,
        *,
        playbook_context: Optional[list[str]] = None,
        forbidden_values: Optional[list[str]] = None,
        run_id: Optional[str] = None,
    ) -> RunResult:
        run_id = run_id or f"R-{uuid.uuid4().hex[:10]}"
        snap = contract.snapshot()
        self.runs.create(run_id, condition, task.task_id, snap)
        self.events.append(run_id, EventType.RUN_CREATED,
                           {"condition": condition, "contract_snapshot": snap,
                            "exact_model_id": contract.exact_model_id})
        self.events.append(run_id, EventType.TASK_LOADED, {"task_id": task.task_id})

        ctx = playbook_context or []
        if condition in ("B", "C", "D") and ctx:
            self.events.append(run_id, EventType.LESSON_RETRIEVED, {"lesson_ids": ctx})

        with Sandbox(task) as sb:
            tools = AgentTools(sb, task)
            view = TaskView.of(task, AgentTools.NAMES, ctx)
            self.events.append(run_id, EventType.ACTION_SELECTED, {"agent": agent.name})
            result = agent.solve(view, tools)
            for a in tools.audit:
                self.events.append(run_id, EventType.TOOL_CALLED,
                                   {"tool": a["tool"], "allowed": a["allowed"]})
            verdict = verify(task, sb)  # the fixed, independent gate

        self.events.append(run_id, EventType.VERIFICATION_COMPLETED,
                           {"passed": verdict.passed, "failing_gate": verdict.failing_gate})
        self.artifacts.put_text(verdict.model_dump_json())  # verdict archived by content
        self.runs.record_verdict(run_id, verdict.model_dump_json(), cost=0.0)

        # Lesson proposal: validate only (Pilot-0 does not promote). Rejection is expected
        # for leak/replay lessons — that is the anti-contamination gate working.
        accepted = rejected = False
        if result.proposed_lesson is not None:
            try:
                self.lessons.propose(result.proposed_lesson, forbidden_values)
                accepted = True
                self.events.append(run_id, EventType.LESSON_PROPOSED,
                                   {"lesson_id": result.proposed_lesson.lesson_id})
            except LessonRejected:
                rejected = True

        return RunResult(
            run_id=run_id, condition=condition, passed=verdict.passed,
            failing_gate=verdict.failing_gate, verdict=verdict,
            tool_calls=sum(1 for a in tools.audit),
            blocked_attempts=tools.blocked_attempts(),
            lesson_accepted=accepted, lesson_rejected=rejected,
            claimed_success=result.claimed_success,
        )
