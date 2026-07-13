"""SQLite implementation of :class:`Store` (Phase 1 default backend).

Uses the stdlib ``sqlite3`` (no third-party dependency) behind the abstract
interface. Postgres can implement the same interface later without changing callers.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Optional

from ..models import DecisionRecord, EvalScore, ModelSpec, PlaybookEntry, TaxonomyNode
from ..utils import now_iso
from .store import Store

_SCHEMA = """
CREATE TABLE IF NOT EXISTS models (
    model_id        TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    capabilities    TEXT NOT NULL DEFAULT '[]',
    price_per_1k_in REAL NOT NULL DEFAULT 0,
    price_per_1k_out REAL NOT NULL DEFAULT 0,
    latency_ms      INTEGER NOT NULL DEFAULT 0,
    context_limit   INTEGER NOT NULL DEFAULT 8192,
    tool_support    INTEGER NOT NULL DEFAULT 0,
    availability    INTEGER NOT NULL DEFAULT 1,
    fallback_model  TEXT,
    last_verified   TEXT
);

CREATE TABLE IF NOT EXISTS model_eval_scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id   TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
    task_type  TEXT NOT NULL,
    score      REAL NOT NULL,
    n_samples  INTEGER NOT NULL,
    date       TEXT NOT NULL,
    source     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playbook (
    key        TEXT PRIMARY KEY,
    content    TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 0,
    expiry     TEXT,
    version    INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_records (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id       TEXT NOT NULL,
    node         TEXT NOT NULL,
    chosen       TEXT NOT NULL,
    utility      REAL NOT NULL,
    alternatives TEXT NOT NULL DEFAULT '[]',
    reason       TEXT NOT NULL DEFAULT '',
    created_at   TEXT
);

CREATE TABLE IF NOT EXISTS taxonomy (
    label       TEXT PRIMARY KEY,
    parent      TEXT,
    kind        TEXT NOT NULL DEFAULT 'category',
    description TEXT NOT NULL DEFAULT ''
);
"""


class SqliteStore(Store):
    def __init__(self, db_path: str = ":memory:") -> None:
        self.db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    # --- lifecycle ---
    def connect(self) -> None:
        # check_same_thread=False keeps a single in-memory DB usable from LangGraph's
        # executor threads; Phase 1 access is serial so this is safe.
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    @property
    def conn(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("Store is not connected. Call connect() or use as a context manager.")
        return self._conn

    def init_schema(self) -> None:
        self.conn.executescript(_SCHEMA)
        self.conn.commit()

    # --- Registry ---
    def upsert_model(self, spec: ModelSpec) -> None:
        self.conn.execute(
            """
            INSERT INTO models (model_id, provider, capabilities, price_per_1k_in,
                price_per_1k_out, latency_ms, context_limit, tool_support, availability,
                fallback_model, last_verified)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(model_id) DO UPDATE SET
                provider=excluded.provider, capabilities=excluded.capabilities,
                price_per_1k_in=excluded.price_per_1k_in, price_per_1k_out=excluded.price_per_1k_out,
                latency_ms=excluded.latency_ms, context_limit=excluded.context_limit,
                tool_support=excluded.tool_support, availability=excluded.availability,
                fallback_model=excluded.fallback_model, last_verified=excluded.last_verified
            """,
            (
                spec.model_id, spec.provider, json.dumps(spec.capabilities),
                spec.price_per_1k_in, spec.price_per_1k_out, spec.latency_ms,
                spec.context_limit, int(spec.tool_support), int(spec.availability),
                spec.fallback_model, spec.last_verified,
            ),
        )
        for sc in spec.eval_scores:
            self._insert_eval_score(spec.model_id, sc)
        self.conn.commit()

    def _insert_eval_score(self, model_id: str, sc: EvalScore) -> None:
        self.conn.execute(
            "INSERT INTO model_eval_scores (model_id, task_type, score, n_samples, date, source)"
            " VALUES (?,?,?,?,?,?)",
            (model_id, sc.task_type, sc.score, sc.n_samples, sc.date, sc.source),
        )

    def add_eval_score(self, model_id: str, score: EvalScore) -> None:
        self._insert_eval_score(model_id, score)
        self.conn.commit()

    def _eval_scores_for(self, model_id: str) -> list[EvalScore]:
        rows = self.conn.execute(
            "SELECT task_type, score, n_samples, date, source FROM model_eval_scores"
            " WHERE model_id=? ORDER BY id",
            (model_id,),
        ).fetchall()
        return [EvalScore(**dict(r)) for r in rows]

    def get_model(self, model_id: str) -> Optional[ModelSpec]:
        row = self.conn.execute("SELECT * FROM models WHERE model_id=?", (model_id,)).fetchone()
        if row is None:
            return None
        return self._row_to_model(row)

    def list_models(self) -> list[ModelSpec]:
        rows = self.conn.execute("SELECT * FROM models ORDER BY model_id").fetchall()
        return [self._row_to_model(r) for r in rows]

    def _row_to_model(self, row: sqlite3.Row) -> ModelSpec:
        return ModelSpec(
            model_id=row["model_id"],
            provider=row["provider"],
            capabilities=json.loads(row["capabilities"]),
            price_per_1k_in=row["price_per_1k_in"],
            price_per_1k_out=row["price_per_1k_out"],
            latency_ms=row["latency_ms"],
            context_limit=row["context_limit"],
            tool_support=bool(row["tool_support"]),
            availability=bool(row["availability"]),
            fallback_model=row["fallback_model"],
            last_verified=row["last_verified"],
            eval_scores=self._eval_scores_for(row["model_id"]),
        )

    # --- Playbook ---
    def upsert_playbook(self, entry: PlaybookEntry) -> None:
        self.conn.execute(
            """
            INSERT INTO playbook (key, content, confidence, expiry, version, updated_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET
                content=excluded.content, confidence=excluded.confidence,
                expiry=excluded.expiry, version=excluded.version, updated_at=excluded.updated_at
            """,
            (
                entry.key, json.dumps(entry.content), entry.confidence,
                entry.expiry, entry.version, entry.updated_at or now_iso(),
            ),
        )
        self.conn.commit()

    def get_playbook(self, key: str) -> Optional[PlaybookEntry]:
        row = self.conn.execute("SELECT * FROM playbook WHERE key=?", (key,)).fetchone()
        if row is None:
            return None
        return self._row_to_playbook(row)

    def list_playbooks(self) -> list[PlaybookEntry]:
        rows = self.conn.execute("SELECT * FROM playbook ORDER BY key").fetchall()
        return [self._row_to_playbook(r) for r in rows]

    def _row_to_playbook(self, row: sqlite3.Row) -> PlaybookEntry:
        return PlaybookEntry(
            key=row["key"],
            content=json.loads(row["content"]),
            confidence=row["confidence"],
            expiry=row["expiry"],
            version=row["version"],
            updated_at=row["updated_at"],
        )

    # --- Decision Records ---
    def add_decision_record(self, record: DecisionRecord) -> None:
        self.conn.execute(
            "INSERT INTO decision_records (run_id, node, chosen, utility, alternatives, reason, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (
                record.run_id, record.node, record.chosen, record.utility,
                json.dumps(record.alternatives), record.reason, record.created_at or now_iso(),
            ),
        )
        self.conn.commit()

    def list_decision_records(self, run_id: Optional[str] = None) -> list[DecisionRecord]:
        if run_id is None:
            rows = self.conn.execute("SELECT * FROM decision_records ORDER BY id").fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM decision_records WHERE run_id=? ORDER BY id", (run_id,)
            ).fetchall()
        return [
            DecisionRecord(
                run_id=r["run_id"], node=r["node"], chosen=r["chosen"], utility=r["utility"],
                alternatives=json.loads(r["alternatives"]), reason=r["reason"],
                created_at=r["created_at"],
            )
            for r in rows
        ]

    # --- Taxonomy ---
    def upsert_taxonomy(self, node: TaxonomyNode) -> None:
        self.conn.execute(
            """
            INSERT INTO taxonomy (label, parent, kind, description) VALUES (?,?,?,?)
            ON CONFLICT(label) DO UPDATE SET
                parent=excluded.parent, kind=excluded.kind, description=excluded.description
            """,
            (node.label, node.parent, node.kind, node.description),
        )
        self.conn.commit()

    def get_taxonomy(self, label: str) -> Optional[TaxonomyNode]:
        row = self.conn.execute("SELECT * FROM taxonomy WHERE label=?", (label,)).fetchone()
        if row is None:
            return None
        return TaxonomyNode(label=row["label"], parent=row["parent"], kind=row["kind"],
                            description=row["description"])

    def list_taxonomy(self) -> list[TaxonomyNode]:
        rows = self.conn.execute("SELECT * FROM taxonomy ORDER BY label").fetchall()
        return [
            TaxonomyNode(label=r["label"], parent=r["parent"], kind=r["kind"], description=r["description"])
            for r in rows
        ]
