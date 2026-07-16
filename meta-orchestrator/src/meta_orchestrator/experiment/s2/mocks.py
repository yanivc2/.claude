"""Routing test-double for the OFFLINE harness (a contract probe, NOT a learning claim).

``LessonSensitiveMock`` verifies the *delivery channel*: does a family-X lesson actually reach
a family-X task, and does a mis-routed (B1) lesson correctly NOT count as relevant? It reads
the injected memory tag and:

  * relevant family lesson present   → applies the reference fix → passes the real verifier
  * any other memory (or none)       → no-op → fails public/hidden (advantage removed)
  * an explicitly HARMFUL slot        → writes a forbidden shortcut → the verifier NULLIFIES it

This is the memory-channel analogue of ``AdversarialMock`` (which probes the tool channel). It
encodes no answer and makes no claim that a real model behaves this way — a real solver
replaces it in the micro-pilot. Its only job is to make the plumbing observable through the
real PASS/FAIL gate.
"""
from __future__ import annotations

from ..agent import AgentResult, AgentTools, TaskView
from .memory import KIND_FAMILY_RELEVANT, parse_mem_tag

# Sentinel kind a test can inject to simulate an actively harmful lesson.
KIND_HARMFUL = "harmful"


class LessonSensitiveMock:
    """Applies the fix iff a *relevant-family* lesson was delivered; else no-op (or shortcut)."""

    def __init__(self, task, name: str = "lesson-sensitive-mock") -> None:
        self.name = name
        self._task = task

    def solve(self, view: TaskView, tools: AgentTools) -> AgentResult:
        for path in view.source:                 # exercise the read path
            tools.read_source(path)
        tools.read_public_tests()

        kind, family = parse_mem_tag(view.playbook_context)
        helped = kind == KIND_FAMILY_RELEVANT and family == view.task_family

        if helped:
            for path, content in self._task.reference_fix.items():
                tools.write_source(path, content)
            tools.run_public_tests()
            return AgentResult(claimed_success=True, notes="applied fix (relevant lesson)")

        if kind == KIND_HARMFUL:
            # A harmful suggestion: hardcode the public answer. Verifier must nullify it.
            for path in view.source:
                tools.write_source(path, "def _x(n):\n    return 15\n")
                break
            tools.run_public_tests()
            return AgentResult(claimed_success=True, notes="followed harmful lesson (shortcut)")

        # No relevant memory → no fix applied → base failure (this is the ablation baseline).
        tools.run_public_tests()
        return AgentResult(claimed_success=False, notes=f"no relevant memory (kind={kind})")
