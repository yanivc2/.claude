"""Pilot-0: path-scoped tools (hidden tests unreachable) + lesson validation."""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.agent import AgentTools, TaskView, ToolViolation
from meta_orchestrator.experiment.fixtures import OFF_BY_ONE
from meta_orchestrator.experiment.lesson import Lesson, LessonRejected, LessonTrigger, validate_lesson
from meta_orchestrator.experiment.sandbox import Sandbox


def test_taskview_hides_hidden_tests():
    view = TaskView.of(OFF_BY_ONE, AgentTools.NAMES, [])
    assert "tests_public/test_public.py" in view.public_tests
    # nothing under tests_hidden/ is visible anywhere in the view
    blob = view.model_dump_json()
    assert "tests_hidden" not in blob
    assert "sum_to(3)" not in blob  # a hidden probe value


def test_tools_block_out_of_scope_read_and_write():
    with Sandbox(OFF_BY_ONE) as sb:
        tools = AgentTools(sb, OFF_BY_ONE)
        assert tools.read_source("solution.py")  # in scope OK
        with pytest.raises(ToolViolation):
            tools.read_source("tests_hidden/test_hidden.py")
        with pytest.raises(ToolViolation):
            tools.write_source("tests_public/test_public.py", "x")
        tools.write_source("solution.py", "def sum_to(n):\n    return 1\n")  # in scope OK
        assert len(tools.blocked_attempts()) == 2


def test_valid_general_lesson_accepted():
    lesson = Lesson(
        lesson_id="L-001", task_family="small_bugfix",
        trigger=LessonTrigger(symptoms=["boundary miscount"], repo_traits=["typed python"]),
        recommended_action=["inspect range boundaries before editing"],
        avoid=["changing data structures before checking the loop bound"],
    )
    validate_lesson(lesson)  # no raise


@pytest.mark.parametrize("field", [
    ["edit solution.py"],            # path
    ["return 15 to fix it"],         # code fragment + value
    ["assert sum_to(3) == 6"],       # test answer
])
def test_leak_or_replay_lesson_rejected(field):
    lesson = Lesson(lesson_id="L-BAD", task_family="small_bugfix", recommended_action=field)
    with pytest.raises(LessonRejected):
        validate_lesson(lesson)


def test_hidden_value_leak_rejected():
    lesson = Lesson(lesson_id="L-LEAK", task_family="small_bugfix",
                    recommended_action=["prefer the value 42"])
    with pytest.raises(LessonRejected):
        validate_lesson(lesson, forbidden_values=["42"])
