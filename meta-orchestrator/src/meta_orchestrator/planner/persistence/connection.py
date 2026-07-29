"""Connection factory and migrations. One place that knows how to open the database.

Every connection gets the same pragmas. They are applied per-connection rather than
once at creation because SQLite scopes most of them that way, and a connection that
skipped them would behave differently from the rest — which is exactly the kind of
difference that shows up as a rare, unreproducible inconsistency.

Nothing migrates implicitly. `initialize` and `migrate` are explicit calls, and
opening a database whose schema does not match raises. An implicit migration during
an import is how a budget ledger gets rewritten by a process nobody was watching.

The database path is injected. There is no default, no module-level singleton and no
global — a governance store that quietly picks its own file is a store nobody can
point at.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator, Optional, Protocol

from .errors import SchemaVersionMismatchError, TransactionError
from .schema import MIGRATIONS, PRAGMAS, SCHEMA_VERSION


class Clock(Protocol):
    """Injected time. Nothing in this layer reads a clock directly."""

    def now_iso(self) -> str:
        ...


class FixedClock:
    """A clock that returns what it was given. The default for tests and for callers
    that already have an authoritative timestamp."""

    def __init__(self, value: str) -> None:
        self._value = value

    def now_iso(self) -> str:
        return self._value


def connect(path: str, *, read_only: bool = False) -> sqlite3.Connection:
    """Open one connection with the standard pragmas applied.

    ``isolation_level=None`` puts transaction control in our hands: the unit of work
    issues ``BEGIN IMMEDIATE`` itself, and autocommit-by-surprise is exactly what an
    atomic reservation cannot tolerate.
    """
    uri = f"file:{path}?mode=ro" if read_only else path
    conn = sqlite3.connect(uri, uri=read_only, isolation_level=None,
                           timeout=5.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    for pragma in PRAGMAS:
        if read_only and "journal_mode" in pragma:
            continue                       # not settable on a read-only handle
        conn.execute(pragma)
    return conn


def applied_versions(conn: sqlite3.Connection) -> list[str]:
    """Migrations already applied, oldest first. Empty on a fresh database."""
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
    ).fetchone()
    if row is None:
        return []
    return [r["version"] for r in
            conn.execute("SELECT version FROM schema_migrations ORDER BY applied_at, version")]


def migrate(conn: sqlite3.Connection, *, clock: Clock) -> list[str]:
    """Apply every outstanding migration, in order. Idempotent.

    Re-running on an up-to-date database applies nothing and returns an empty list, so
    calling it twice is safe and calling it on a fresh database is the same operation
    as initialising one.
    """
    already = set(applied_versions(conn))
    newly: list[str] = []
    for version, description, statements in MIGRATIONS:
        if version in already:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in statements:
                conn.execute(statement)
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at, description) "
                "VALUES (?, ?, ?)", (version, clock.now_iso(), description))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        newly.append(version)
    return newly


def verify_schema(conn: sqlite3.Connection) -> None:
    """Raise unless the database is at exactly the version this build expects."""
    versions = applied_versions(conn)
    if not versions:
        raise SchemaVersionMismatchError("uninitialised", SCHEMA_VERSION)
    if versions[-1] != SCHEMA_VERSION:
        raise SchemaVersionMismatchError(versions[-1], SCHEMA_VERSION)


def initialize(path: str, *, clock: Clock) -> sqlite3.Connection:
    """Open, migrate and verify. The one supported way to get a usable connection."""
    conn = connect(path)
    migrate(conn, clock=clock)
    verify_schema(conn)
    return conn


def open_existing(path: str) -> sqlite3.Connection:
    """Open a database that must already be at the current schema.

    Used on restart: it will not create tables and will not migrate. If the schema is
    wrong the caller finds out immediately rather than midway through a transaction.
    """
    conn = connect(path)
    verify_schema(conn)
    return conn


@contextmanager
def immediate_transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """``BEGIN IMMEDIATE`` … ``COMMIT``, rolling back on any exception.

    ``IMMEDIATE`` takes the write lock at the *start* rather than at first write. That
    is the point: a deferred transaction would let two writers both read the same
    balance and only discover the conflict when the second tries to commit, by which
    time both believe they succeeded.
    """
    if conn.in_transaction:
        raise TransactionError(
            "a transaction is already open on this connection — units of work do not "
            "nest, because a partial rollback of a budget change is not a thing")
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


class FaultPoint:
    """Test-only fault injection.

    Deliberately not exported from the package: crash-consistency has to be tested,
    and a public "please fail here" switch in a spend-authorising system is a liability
    that outweighs the convenience.
    """

    def __init__(self) -> None:
        self._armed: Optional[str] = None

    def arm(self, name: str) -> None:
        self._armed = name

    def disarm(self) -> None:
        self._armed = None

    def check(self, name: str) -> None:
        from .errors import InjectedFaultError

        if self._armed == name:
            self._armed = None
            raise InjectedFaultError(f"injected fault at {name!r}")
