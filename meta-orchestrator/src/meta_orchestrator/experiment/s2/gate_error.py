"""Leaf module for ``GateError`` — the shared block-the-paid-call exception.

Kept import-free so any module (including early ones like ``families``) can subclass it without a
circular import. ``gates`` re-exports it, so ``from .gates import GateError`` still works everywhere.
"""
from __future__ import annotations


class GateError(RuntimeError):
    """A gate or runtime invariant was violated — the paid call is blocked."""
