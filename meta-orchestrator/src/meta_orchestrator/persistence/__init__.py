"""Persistence layer — a Store abstraction so the backend is swappable.

Phase 1 uses SQLite (zero-setup, runnable/testable offline). The abstract
``Store`` interface lets a PostgreSQL implementation drop in later (SPEC §16.8)
without touching orchestration logic.
"""
from .sqlite_store import SqliteStore
from .store import Store

__all__ = ["Store", "SqliteStore"]
