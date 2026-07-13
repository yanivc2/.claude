"""Verification layer (SPEC §5.4). Uniform ``verify()`` result shape for every node."""
from ..models import FailureCategory, VerifyResult
from .code_verifier import verify_code_fix

__all__ = ["VerifyResult", "FailureCategory", "verify_code_fix"]
