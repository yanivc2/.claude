"""Tool Gateway with a permission-tier ladder (SPEC §11, C2).

Read-only / Low / Medium tools run autonomously; **High-impact tools always require
approval** (send/delete/production/payment). A single gateway is the choke point so
every tool call is subject to the same policy.
"""
from __future__ import annotations

from enum import IntEnum
from typing import Any, Callable, Optional

from ..seed_task.definition import BugCase
from ..verification.code_verifier import verify_code_fix


class PermissionTier(IntEnum):
    READ_ONLY = 0
    LOW = 1
    MEDIUM = 2
    HIGH = 3  # send / delete / production / payment → approval ALWAYS required


class ApprovalRequiredError(RuntimeError):
    """A High-impact tool was invoked without (or with a denied) approval."""


# approver(tool_name, args) -> bool  (True = approve)
Approver = Callable[[str, dict[str, Any]], bool]


class Tool:
    def __init__(self, name: str, tier: PermissionTier, fn: Callable[[dict[str, Any]], Any]) -> None:
        self.name = name
        self.tier = tier
        self.fn = fn


class ToolGateway:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}
        self.audit: list[dict[str, Any]] = []  # SPEC §11 audit trail

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        return self._tools[name]

    def invoke(self, name: str, args: dict[str, Any], *, approver: Optional[Approver] = None) -> Any:
        tool = self._tools[name]
        approved = True
        if tool.tier >= PermissionTier.HIGH:
            # High-impact: must be explicitly approved every time (SPEC §11).
            approved = bool(approver and approver(name, args))
            if not approved:
                self.audit.append({"tool": name, "tier": int(tool.tier), "approved": False})
                raise ApprovalRequiredError(f"tool {name!r} (HIGH) requires approval")
        result = tool.fn(args)
        self.audit.append({"tool": name, "tier": int(tool.tier), "approved": approved})
        return result


# --- seed-task tool implementations ---
def _search(args: dict[str, Any]) -> dict[str, Any]:
    # Read-only stub: Phase 1 seed task needs no live data. Returns an empty result set.
    return {"query": args.get("query", ""), "results": []}


def _run_tests(args: dict[str, Any]):
    # LOW: runs pytest in an isolated temp dir via the verifier (no repo mutation).
    case: BugCase = args["case"]
    return verify_code_fix(case, args["candidate_source"])


def _persist_artifact(args: dict[str, Any]) -> dict[str, Any]:
    # HIGH: would write the accepted fix to the real target (repo/production).
    # In the offline MVP this is a no-op that just echoes what WOULD be written.
    return {"persisted": True, "path": args.get("path", "solution.py")}


def default_tool_gateway() -> ToolGateway:
    gw = ToolGateway()
    gw.register(Tool("search", PermissionTier.READ_ONLY, _search))
    gw.register(Tool("run_tests", PermissionTier.LOW, _run_tests))
    gw.register(Tool("persist_artifact", PermissionTier.HIGH, _persist_artifact))
    return gw
