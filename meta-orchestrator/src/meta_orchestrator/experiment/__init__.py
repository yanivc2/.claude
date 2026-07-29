"""Controlled learning experiment (Phase-1 validation v2).

This package is the measurement apparatus — deliberately separate from the agent
backbone. The measured agent runs through a *controlled runner* with a frozen
contract (v2 §5), a sandbox with repo-reset, and a fixed composite verifier the
learning policy cannot touch (v2 §6). Pilot-0 qualifies the harness itself
(no real model, no learning claims); see README.md for the section→module map.
"""
from .agent import AgentResult, AgentTools, MeasuredAgent, TaskView, ToolViolation
from .artifacts import ArtifactStore
from .contract import AgentContract
from .lesson import Lesson, LessonRejected, validate_lesson
from .mocks import AdversarialMock, ProtocolMock
from .runner import ControlledRunner, RunResult
from .sandbox import Sandbox
from .store import EventLog, EventType, ExperimentDB, LessonStore, PlaybookStore, RunStore
from .task import ExperimentTask
from .verifier import Verdict, verify

__all__ = [
    "ExperimentTask", "AgentContract", "Sandbox", "verify", "Verdict",
    "Lesson", "validate_lesson", "LessonRejected",
    "TaskView", "AgentTools", "MeasuredAgent", "AgentResult", "ToolViolation",
    "ProtocolMock", "AdversarialMock",
    "ExperimentDB", "EventLog", "EventType", "RunStore", "LessonStore", "PlaybookStore",
    "ArtifactStore", "ControlledRunner", "RunResult",
]
