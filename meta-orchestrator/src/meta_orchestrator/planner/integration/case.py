"""The narrow view of a task the shadow integration needs.

A structural type, deliberately. The integration layer must not depend on the
orchestrator's domain objects — that coupling is what P2a keeps out of the Planner. Any
object carrying these four fields (the orchestrator's ``BugCase`` is one) can be
shadowed, and the Planner stays ignorant of everything else about it.
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class ShadowCase(Protocol):
    """What the adapter reads off a task, and nothing more."""

    @property
    def bug_id(self) -> str: ...

    @property
    def module_filename(self) -> str: ...

    @property
    def module_source(self) -> str: ...

    @property
    def test_source(self) -> str: ...
