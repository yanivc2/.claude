"""Tool Gateway (SPEC §11): single entry point with a permission tier ladder."""
from .gateway import (
    ApprovalRequiredError,
    PermissionTier,
    Tool,
    ToolGateway,
    default_tool_gateway,
)

__all__ = [
    "ToolGateway",
    "Tool",
    "PermissionTier",
    "ApprovalRequiredError",
    "default_tool_gateway",
]
