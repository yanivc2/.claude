"""Pilot-0: storage ports — migrations, append-only event log + projection, artifacts."""
from __future__ import annotations

import pytest

from meta_orchestrator.experiment.artifacts import ArtifactStore
from meta_orchestrator.experiment.lesson import Lesson, LessonRejected
from meta_orchestrator.experiment.store import (
    EventLog,
    EventType,
    ExperimentDB,
    LessonStore,
    PlaybookStore,
    RunStore,
)


def test_migrations_applied():
    db = ExperimentDB(":memory:")
    v = db.conn.execute("SELECT version FROM schema_version").fetchone()["version"]
    assert v == 1
    tables = {r["name"] for r in db.conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert {"events", "runs", "lessons", "playbook_versions"} <= tables
    db.close()


def test_event_log_append_only_and_projection():
    db = ExperimentDB(":memory:")
    log = EventLog(db)
    log.append("R1", EventType.RUN_CREATED, {"condition": "A"})
    log.append("R1", EventType.TOOL_CALLED, {"tool": "read_source", "allowed": True})
    log.append("R1", EventType.TOOL_CALLED, {"tool": "write_source", "allowed": True})
    log.append("R1", EventType.VERIFICATION_COMPLETED, {"passed": True})
    seqs = [e["seq"] for e in log.events("R1")]
    assert seqs == [0, 1, 2, 3]                 # monotonic, append-only
    state = log.project("R1")
    assert state["tool_calls"] == 2
    assert state["verified"] is True
    db.close()


def test_run_store_roundtrip():
    db = ExperimentDB(":memory:")
    runs = RunStore(db)
    runs.create("R1", "C", "task-1", "snap-abc")
    runs.record_verdict("R1", '{"passed": true}', cost=0.01)
    row = runs.get("R1")
    assert row["condition"] == "C" and row["contract_snapshot"] == "snap-abc"
    assert row["cost"] == 0.01
    db.close()


def test_lesson_store_validates_before_storing():
    db = ExperimentDB(":memory:")
    store = LessonStore(db)
    good = Lesson(lesson_id="L-1", task_family="small_bugfix",
                  recommended_action=["inspect boundaries first"])
    store.propose(good)
    assert store.get("L-1") is not None
    bad = Lesson(lesson_id="L-2", task_family="small_bugfix",
                 recommended_action=["edit solution.py"])
    with pytest.raises(LessonRejected):
        store.propose(bad)
    assert store.get("L-2") is None             # rejected → not stored
    assert [l.lesson_id for l in store.by_family("small_bugfix")] == ["L-1"]
    db.close()


def test_playbook_versions_increment():
    db = ExperimentDB(":memory:")
    pb = PlaybookStore(db)
    assert pb.create_version({"rules": []}) == 1
    assert pb.create_version({"rules": ["L-1"]}) == 2
    assert pb.current() == {"rules": ["L-1"]}
    db.close()


def test_artifact_store_is_content_addressed(tmp_path):
    store = ArtifactStore(str(tmp_path / "artifacts"))
    a = store.put_text("hello")
    b = store.put_text("hello")
    assert a == b                                # dedup by content
    assert store.get_text(a) == "hello"
    assert store.put_text("world") != a
