"""SQLite store with small ports (v2 §10): append-only event log + RunStore /
LessonStore / PlaybookStore. Not an ORM — just the operations the experiment needs,
behind narrow classes so a Postgres backend can replace them later (contract-tested).

Migrations run from day one (schema_version, FK on, transactions, unique/idempotency
keys). State is a *projection* of the append-only event log — the log is the source of truth.
"""
from __future__ import annotations

import json
import sqlite3
from enum import Enum
from typing import Any, Optional

from ..utils import now_iso
from .lesson import Lesson, validate_lesson


class EventType(str, Enum):
    RUN_CREATED = "RUN_CREATED"
    TASK_LOADED = "TASK_LOADED"
    LESSON_RETRIEVED = "LESSON_RETRIEVED"
    ACTION_SELECTED = "ACTION_SELECTED"
    TOOL_CALLED = "TOOL_CALLED"
    VERIFICATION_COMPLETED = "VERIFICATION_COMPLETED"
    LESSON_PROPOSED = "LESSON_PROPOSED"
    LESSON_PROMOTED = "LESSON_PROMOTED"
    PLAYBOOK_VERSION_CREATED = "PLAYBOOK_VERSION_CREATED"


_MIGRATIONS = [
    # v1
    """
    CREATE TABLE events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id   TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        type     TEXT NOT NULL,
        payload  TEXT NOT NULL DEFAULT '{}',
        ts       TEXT NOT NULL,
        UNIQUE (run_id, seq)                       -- idempotency key
    );
    CREATE TABLE runs (
        run_id            TEXT PRIMARY KEY,
        condition         TEXT NOT NULL,
        task_id           TEXT NOT NULL,
        contract_snapshot TEXT NOT NULL,
        verdict           TEXT,
        cost              REAL NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL
    );
    CREATE TABLE lessons (
        lesson_id  TEXT PRIMARY KEY,
        task_family TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'candidate',
        version    INTEGER NOT NULL DEFAULT 1,
        content    TEXT NOT NULL
    );
    CREATE TABLE playbook_versions (
        version    INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        content    TEXT NOT NULL
    );
    """,
]


class ExperimentDB:
    def __init__(self, path: str = ":memory:") -> None:
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._migrate()

    def _migrate(self) -> None:
        self.conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
        row = self.conn.execute("SELECT version FROM schema_version").fetchone()
        current = row["version"] if row else 0
        if row is None:
            self.conn.execute("INSERT INTO schema_version (version) VALUES (0)")
        for i in range(current, len(_MIGRATIONS)):
            self.conn.executescript(_MIGRATIONS[i])
            self.conn.execute("UPDATE schema_version SET version = ?", (i + 1,))
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()


class EventLog:
    """Append-only log; state is derived by projection."""

    def __init__(self, db: ExperimentDB) -> None:
        self._db = db

    def append(self, run_id: str, type_: EventType, payload: Optional[dict] = None) -> int:
        cur = self._db.conn.execute("SELECT COALESCE(MAX(seq), -1) + 1 AS nxt FROM events WHERE run_id=?",
                                    (run_id,))
        seq = cur.fetchone()["nxt"]
        self._db.conn.execute(
            "INSERT INTO events (run_id, seq, type, payload, ts) VALUES (?,?,?,?,?)",
            (run_id, seq, type_.value, json.dumps(payload or {}), now_iso()),
        )
        self._db.conn.commit()
        return seq

    def events(self, run_id: str) -> list[dict[str, Any]]:
        rows = self._db.conn.execute(
            "SELECT seq, type, payload, ts FROM events WHERE run_id=? ORDER BY seq", (run_id,)
        ).fetchall()
        return [{"seq": r["seq"], "type": r["type"], "payload": json.loads(r["payload"]), "ts": r["ts"]}
                for r in rows]

    def project(self, run_id: str) -> dict[str, Any]:
        """Fold the log into run state (v2 §10: state = projection of events)."""
        state: dict[str, Any] = {"run_id": run_id, "tool_calls": 0, "verified": None,
                                 "lessons_retrieved": [], "types": []}
        for e in self.events(run_id):
            state["types"].append(e["type"])
            if e["type"] == EventType.TOOL_CALLED.value:
                state["tool_calls"] += 1
            elif e["type"] == EventType.LESSON_RETRIEVED.value:
                state["lessons_retrieved"] = e["payload"].get("lesson_ids", [])
            elif e["type"] == EventType.VERIFICATION_COMPLETED.value:
                state["verified"] = e["payload"].get("passed")
        return state


class RunStore:
    def __init__(self, db: ExperimentDB) -> None:
        self._db = db

    def create(self, run_id: str, condition: str, task_id: str, contract_snapshot: str) -> None:
        self._db.conn.execute(
            "INSERT INTO runs (run_id, condition, task_id, contract_snapshot, created_at)"
            " VALUES (?,?,?,?,?)",
            (run_id, condition, task_id, contract_snapshot, now_iso()),
        )
        self._db.conn.commit()

    def record_verdict(self, run_id: str, verdict_json: str, cost: float) -> None:
        self._db.conn.execute("UPDATE runs SET verdict=?, cost=? WHERE run_id=?",
                              (verdict_json, cost, run_id))
        self._db.conn.commit()

    def get(self, run_id: str) -> Optional[dict[str, Any]]:
        row = self._db.conn.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return dict(row) if row else None


class LessonStore:
    """Candidate lessons. propose() validates for forbidden content BEFORE storing."""

    def __init__(self, db: ExperimentDB) -> None:
        self._db = db

    def propose(self, lesson: Lesson, forbidden_values: Optional[list[str]] = None) -> None:
        validate_lesson(lesson, forbidden_values)  # raises LessonRejected on leak/replay
        self._db.conn.execute(
            "INSERT INTO lessons (lesson_id, task_family, status, version, content)"
            " VALUES (?,?,?,?,?) ON CONFLICT(lesson_id) DO UPDATE SET"
            " status=excluded.status, version=excluded.version, content=excluded.content",
            (lesson.lesson_id, lesson.task_family, lesson.status, lesson.version,
             lesson.model_dump_json()),
        )
        self._db.conn.commit()

    def get(self, lesson_id: str) -> Optional[Lesson]:
        row = self._db.conn.execute("SELECT content FROM lessons WHERE lesson_id=?",
                                    (lesson_id,)).fetchone()
        return Lesson.model_validate_json(row["content"]) if row else None

    def by_family(self, task_family: str, status: Optional[str] = None) -> list[Lesson]:
        if status:
            rows = self._db.conn.execute(
                "SELECT content FROM lessons WHERE task_family=? AND status=? ORDER BY lesson_id",
                (task_family, status)).fetchall()
        else:
            rows = self._db.conn.execute(
                "SELECT content FROM lessons WHERE task_family=? ORDER BY lesson_id",
                (task_family,)).fetchall()
        return [Lesson.model_validate_json(r["content"]) for r in rows]


class PlaybookStore:
    def __init__(self, db: ExperimentDB) -> None:
        self._db = db

    def create_version(self, content: dict[str, Any]) -> int:
        row = self._db.conn.execute("SELECT COALESCE(MAX(version), 0) + 1 AS nxt "
                                    "FROM playbook_versions").fetchone()
        version = row["nxt"]
        self._db.conn.execute("INSERT INTO playbook_versions (version, created_at, content) VALUES (?,?,?)",
                             (version, now_iso(), json.dumps(content)))
        self._db.conn.commit()
        return version

    def current(self) -> Optional[dict[str, Any]]:
        row = self._db.conn.execute(
            "SELECT content FROM playbook_versions ORDER BY version DESC LIMIT 1").fetchone()
        return json.loads(row["content"]) if row else None
