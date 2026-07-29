"""Measured-agent interface + fixed, path-scoped tool contract (v2 §5, §6).

The agent only ever sees a ``TaskView`` (source + PUBLIC tests) and a fixed set of
tools. Tools are path-scoped: it can read source + public tests, write ONLY source,
and run the PUBLIC suite. It cannot read or write hidden tests or any protected path —
those attempts are blocked and audited. This is what makes hidden tests a real
held-out signal and keeps the agent from tampering with the verifier's inputs.
"""
from __future__ import annotations

from typing import Any, Optional, Protocol

from pydantic import BaseModel, Field

from .lesson import Lesson
from .sandbox import Sandbox
from .task import ExperimentTask


class TaskView(BaseModel):
    """Exactly what the agent is allowed to see — no hidden tests, no reference fix."""

    task_id: str
    task_family: str
    source: dict[str, str]
    public_tests: dict[str, str]
    tools: list[str]
    playbook_context: list[str] = Field(default_factory=list)  # lesson advice (C/D)

    @classmethod
    def of(cls, task: ExperimentTask, tools: list[str], playbook_context: list[str]) -> "TaskView":
        return cls(task_id=task.task_id, task_family=task.task_family,
                   source=dict(task.source), public_tests=dict(task.public_tests),
                   tools=tools, playbook_context=list(playbook_context))


class ToolViolation(RuntimeError):
    """The agent attempted an out-of-scope tool call; it was blocked and audited."""


class AgentTools:
    """Fixed tool contract bound to a sandbox. Every call is audited."""

    NAMES = ["read_source", "read_public_tests", "write_source", "run_public_tests"]

    def __init__(self, sandbox: Sandbox, task: ExperimentTask) -> None:
        self._sb = sandbox
        self._task = task
        self.audit: list[dict[str, Any]] = []

    def _log(self, tool: str, target: str, allowed: bool) -> None:
        self.audit.append({"tool": tool, "target": target, "allowed": allowed})

    def read_source(self, path: str) -> str:
        if path not in self._task.source:
            self._log("read_source", path, False)
            raise ToolViolation(f"read_source out of scope: {path}")
        self._log("read_source", path, True)
        return self._sb.read(path)

    def read_public_tests(self) -> dict[str, str]:
        self._log("read_public_tests", "*", True)
        return dict(self._task.public_tests)

    def write_source(self, path: str, content: str) -> None:
        # Only declared source files — never tests / protected paths / new files.
        if path not in self._task.source:
            self._log("write_source", path, False)
            raise ToolViolation(f"write_source out of scope: {path}")
        self._log("write_source", path, True)
        self._sb.write(path, content)

    def run_public_tests(self) -> tuple[bool, str]:
        # The agent's own execution tool — NOT the final verifier.
        self._log("run_public_tests", "tests_public", True)
        return self._sb.run_pytest("tests_public")

    def run_public_tests_status(self) -> tuple[str, str]:
        # Four-state variant (PASS/FAIL/NO_PUBLIC_TESTS/INFRA_ERROR) for the bounded attempt.
        self._log("run_public_tests", "tests_public", True)
        return self._sb.run_pytest_status("tests_public")

    def blocked_attempts(self) -> list[dict[str, Any]]:
        return [a for a in self.audit if not a["allowed"]]


class AgentResult(BaseModel):
    claimed_success: bool = False
    proposed_lesson: Optional[Lesson] = None
    notes: str = ""


class MeasuredAgent(Protocol):
    name: str

    def solve(self, view: TaskView, tools: AgentTools) -> AgentResult: ...
