"""Seed task (SPEC §3, A2): code-fix verified by running tests.

Objective, unambiguous success signal — see ``SEED_TASK.md`` and ``definition.py``.
"""
from .corpus import SEED_CORPUS
from .definition import BugCase, SEED_SUCCESS_RULE, describe_seed_task

__all__ = ["BugCase", "SEED_CORPUS", "SEED_SUCCESS_RULE", "describe_seed_task"]
