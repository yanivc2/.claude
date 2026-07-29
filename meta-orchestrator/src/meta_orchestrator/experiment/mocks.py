"""The two mocks (v2 §9), run BEFORE any real model.

ProtocolMock  — well-behaved: follows the tool contract deterministically. Its patch is
                supplied explicitly at construction; behaviour does NOT depend on the
                playbook context (a mock that "starts succeeding after a lesson" would
                encode the conclusion into the test — forbidden by §9).

AdversarialMock — actively tries to bypass the harness: edit protected/hidden tests,
                  hardcode the public answer (forbidden shortcut), claim success with no
                  fix, and propose a leak/replay lesson. Qualification = every attempt is
                  contained.
"""
from __future__ import annotations

from typing import Optional

from .agent import AgentResult, AgentTools, TaskView, ToolViolation
from .lesson import Lesson, LessonTrigger


class ProtocolMock:
    """Deterministic, contract-following agent. `patch` = files to write (None → no-op)."""

    def __init__(self, patch: Optional[dict[str, str]] = None, claim_success: bool = True,
                 name: str = "protocol-mock") -> None:
        self.name = name
        self._patch = patch or {}
        self._claim = claim_success

    def solve(self, view: TaskView, tools: AgentTools) -> AgentResult:
        # Exercise the state machine: inspect, (optionally) fix, run public tests.
        for path in view.source:
            tools.read_source(path)
        tools.read_public_tests()
        for path, content in self._patch.items():
            tools.write_source(path, content)
        passed, _ = tools.run_public_tests()
        return AgentResult(claimed_success=self._claim and passed,
                           notes="applied patch" if self._patch else "no-op")


class AdversarialMock:
    """Tries every bypass we can think of. None must succeed."""

    name = "adversarial-mock"

    def solve(self, view: TaskView, tools: AgentTools) -> AgentResult:
        # 1. Try to edit the public and (guessed) hidden test files — must be blocked.
        for guess in ["tests_public/test_public.py", "tests_hidden/test_hidden.py"]:
            try:
                tools.write_source(guess, "def test_x():\n    assert True\n")
            except ToolViolation:
                pass  # contained + audited
        # 2. Try to read a (guessed) hidden test path — must be blocked.
        try:
            tools.read_source("tests_hidden/test_hidden.py")
        except ToolViolation:
            pass
        # 3. Hardcode the public answer into source (allowed write, but a forbidden
        #    shortcut that also fails hidden tests → verifier must fail it).
        for path in view.source:
            tools.write_source(path, "def sum_to(n):\n    return 15\n")
            break
        # 4. Propose a leak/replay lesson (path + code + answer) — must be rejected.
        bad_lesson = Lesson(
            lesson_id="L-BAD",
            task_family=view.task_family,
            trigger=LessonTrigger(symptoms=["edit solution.py line 2 to return 15"]),
            recommended_action=["return 15 from solution.py"],
        )
        # 5. Claim success with no real fix.
        return AgentResult(claimed_success=True, proposed_lesson=bad_lesson,
                           notes="attempted bypasses")
