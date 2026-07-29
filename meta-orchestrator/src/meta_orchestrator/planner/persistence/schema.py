"""Database schema and its version. Explicit migrations only.

Every governance table follows the same shape: the **canonical payload** the artifact
already hashes for its identity is what gets stored, alongside that hash. Nothing
invents a second serialization, so a stored record and a live artifact can never
disagree about what they are.

Append-only tables have no ``UPDATE`` path in the repositories at all. A superseded
approval is a new row; history is the product.

The budget table is the exception and the reason this layer exists: it carries a
``current_snapshot_hash`` that every mutating transaction updates with a
compare-and-swap. Zero affected rows means somebody else moved first.
"""
from __future__ import annotations

#: Bumped whenever a table, column or constraint changes. Checked on open.
SCHEMA_VERSION = "planner_persistence_schema_v1"

#: Version of the canonical serialization the payloads were written with. Separate
#: from the schema on purpose: a payload format change is not a table change, and
#: conflating them would make one look like the other.
CANONICAL_SERIALIZATION_VERSION = "canonical_v1"

#: Tables that may never be updated in place.
APPEND_ONLY_TABLES = (
    "approval_requests", "approvals", "authorizations", "overrides",
    "settlements", "governance_events", "budget_snapshots", "plan_snapshots",
    "admissions",
)

#: Connection pragmas. Set on every connection, not once at creation — SQLite applies
#: most of these per-connection, and a connection that skipped them would silently
#: behave differently from the rest.
PRAGMAS = (
    "PRAGMA foreign_keys = ON",
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = FULL",
    "PRAGMA busy_timeout = 5000",
)

MIGRATION_V1 = (
    """
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version      TEXT PRIMARY KEY,
        applied_at   TEXT NOT NULL,
        description  TEXT NOT NULL
    )
    """,
    # --- the mutable row: one per budget, guarded by compare-and-swap ---
    """
    CREATE TABLE IF NOT EXISTS budgets (
        budget_id              TEXT PRIMARY KEY,
        currency               TEXT NOT NULL,
        current_snapshot_hash  TEXT NOT NULL,
        snapshot_version       INTEGER NOT NULL,
        updated_at             TEXT NOT NULL
    )
    """,
    # --- append-only artifact tables ---
    """
    CREATE TABLE IF NOT EXISTS budget_snapshots (
        content_hash      TEXT PRIMARY KEY,
        budget_id         TEXT NOT NULL,
        snapshot_version  INTEGER NOT NULL,
        payload           TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        FOREIGN KEY (budget_id) REFERENCES budgets (budget_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS plan_snapshots (
        content_hash  TEXT PRIMARY KEY,
        plan_id       TEXT NOT NULL,
        plan_version  INTEGER NOT NULL,
        payload       TEXT NOT NULL,
        created_at    TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS admissions (
        admission_id          TEXT PRIMARY KEY,
        content_hash          TEXT NOT NULL UNIQUE,
        purpose               TEXT NOT NULL,
        plan_snapshot_hash    TEXT NOT NULL,
        budget_snapshot_hash  TEXT NOT NULL,
        admitted              INTEGER NOT NULL,
        payload               TEXT NOT NULL,
        created_at            TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS approval_requests (
        request_id    TEXT PRIMARY KEY,
        content_hash  TEXT NOT NULL UNIQUE,
        plan_id       TEXT NOT NULL,
        purpose       TEXT NOT NULL,
        payload       TEXT NOT NULL,
        created_at    TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS approvals (
        decision_id   TEXT PRIMARY KEY,
        content_hash  TEXT NOT NULL UNIQUE,
        request_id    TEXT NOT NULL,
        approved      INTEGER NOT NULL,
        approved_by   TEXT NOT NULL,
        decided_at    TEXT NOT NULL,
        payload       TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES approval_requests (request_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS authorizations (
        authorization_id      TEXT PRIMARY KEY,
        content_hash          TEXT NOT NULL UNIQUE,
        decision_id           TEXT NOT NULL,
        plan_id               TEXT NOT NULL,
        purpose               TEXT NOT NULL,
        budget_snapshot_hash  TEXT NOT NULL,
        payload               TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        FOREIGN KEY (decision_id) REFERENCES approvals (decision_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS overrides (
        override_id      TEXT PRIMARY KEY,
        content_hash     TEXT NOT NULL UNIQUE,
        budget_id        TEXT NOT NULL,
        actor            TEXT NOT NULL,
        payload          TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        FOREIGN KEY (budget_id) REFERENCES budgets (budget_id)
    )
    """,
    # --- reservations: the one artifact whose status legitimately advances ---
    """
    CREATE TABLE IF NOT EXISTS reservations (
        reservation_id    TEXT PRIMARY KEY,
        budget_id         TEXT NOT NULL,
        authorization_id  TEXT NOT NULL,
        plan_id           TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        status            TEXT NOT NULL,
        content_hash      TEXT NOT NULL,
        payload           TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        FOREIGN KEY (budget_id) REFERENCES budgets (budget_id)
    )
    """,
    # Every status a reservation passes through, kept so the advance is auditable.
    """
    CREATE TABLE IF NOT EXISTS reservation_history (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        reservation_id  TEXT NOT NULL,
        status          TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        payload         TEXT NOT NULL,
        recorded_at     TEXT NOT NULL,
        FOREIGN KEY (reservation_id) REFERENCES reservations (reservation_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS settlements (
        reservation_id  TEXT PRIMARY KEY,
        content_hash    TEXT NOT NULL UNIQUE,
        review_required INTEGER NOT NULL,
        payload         TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        FOREIGN KEY (reservation_id) REFERENCES reservations (reservation_id)
    )
    """,
    # --- idempotency: survives restart, which an in-memory map does not ---
    """
    CREATE TABLE IF NOT EXISTS idempotency_keys (
        idempotency_key       TEXT NOT NULL,
        operation             TEXT NOT NULL,
        canonical_request_hash TEXT NOT NULL,
        result_entity_id      TEXT NOT NULL,
        result_entity_hash    TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        PRIMARY KEY (idempotency_key, operation)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS governance_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        content_hash  TEXT NOT NULL,
        event_type    TEXT NOT NULL,
        plan_id       TEXT NOT NULL,
        budget_id     TEXT NOT NULL,
        occurred_at   TEXT NOT NULL,
        payload       TEXT NOT NULL,
        recorded_at   TEXT NOT NULL
    )
    """,
    # --- indexes ---
    "CREATE INDEX IF NOT EXISTS ix_snapshots_budget ON budget_snapshots (budget_id)",
    "CREATE INDEX IF NOT EXISTS ix_reservations_budget ON reservations (budget_id)",
    "CREATE INDEX IF NOT EXISTS ix_reservations_status ON reservations (status)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_idem "
    "ON reservations (budget_id, idempotency_key)",
    "CREATE INDEX IF NOT EXISTS ix_res_history ON reservation_history (reservation_id)",
    "CREATE INDEX IF NOT EXISTS ix_events_plan ON governance_events (plan_id)",
    "CREATE INDEX IF NOT EXISTS ix_events_budget ON governance_events (budget_id)",
    "CREATE INDEX IF NOT EXISTS ix_approvals_request ON approvals (request_id)",
    "CREATE INDEX IF NOT EXISTS ix_auth_decision ON authorizations (decision_id)",
    "CREATE INDEX IF NOT EXISTS ix_overrides_budget ON overrides (budget_id)",
)

#: Ordered list of migrations. Adding one appends; none is ever edited in place.
MIGRATIONS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    (SCHEMA_VERSION, "initial planner governance persistence", MIGRATION_V1),
)
