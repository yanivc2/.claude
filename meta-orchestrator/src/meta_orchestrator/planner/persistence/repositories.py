"""SQLite repositories. Parameterised SQL only, hashes verified on every read.

Append-only tables have no update path here at all — not a guarded one, not a private
one. The guarantee is structural rather than disciplined: there is no method to call.

Every read goes through :mod:`.records`, which re-computes the hash and rebuilds the
artifact through its own constructor. A row that fails either check raises rather than
being returned in a weaker form.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any, Callable, Optional

from ..governance.authorization import ExecutionAuthorization
from ..governance.events import GovernanceEvent
from ..governance.override import BudgetOverride
from ..governance.reservation import SettlementResult, SpendReservation
from ..governance.snapshots import BudgetSnapshot, PlanSnapshot
from . import rebuild
from .errors import AppendOnlyViolationError, RecordNotFoundError
from .records import dump, load, verify_only


class _Repo:
    """Shared plumbing: a connection and an injected clock."""

    def __init__(self, conn: sqlite3.Connection, now: Callable[[], str]) -> None:
        self._conn = conn
        self._now = now

    def _insert_append_only(self, table: str, entity_id: str, columns: dict[str, Any]
                            ) -> None:
        names = ", ".join(columns)
        holes = ", ".join("?" for _ in columns)
        try:
            self._conn.execute(f"INSERT INTO {table} ({names}) VALUES ({holes})",
                               tuple(columns.values()))
        except sqlite3.IntegrityError as exc:
            if "UNIQUE" in str(exc) or "PRIMARY KEY" in str(exc):
                raise AppendOnlyViolationError(table, entity_id) from exc
            raise


class SqliteBudgetSnapshotStore(_Repo):
    TABLE = "budget_snapshots"

    def put(self, snapshot: BudgetSnapshot) -> None:
        payload, digest = dump(snapshot)
        # A snapshot is content-addressed: re-storing an identical one is a no-op
        # rather than a conflict, because two callers deriving the same state is
        # normal and is not a rewrite.
        existing = self._conn.execute(
            f"SELECT 1 FROM {self.TABLE} WHERE content_hash = ?", (digest,)).fetchone()
        if existing:
            return
        self._insert_append_only(self.TABLE, digest, {
            "content_hash": digest, "budget_id": snapshot.budget_id,
            "snapshot_version": snapshot.snapshot_version, "payload": payload,
            "created_at": snapshot.taken_at or self._now()})

    def get(self, content_hash: str) -> BudgetSnapshot:
        row = self._conn.execute(
            f"SELECT payload, content_hash, created_at FROM {self.TABLE} "
            "WHERE content_hash = ?", (content_hash,)).fetchone()
        if row is None:
            raise RecordNotFoundError(self.TABLE, content_hash)
        return load(row["payload"], row["content_hash"], table=self.TABLE,
                    entity_id=content_hash,
                    rebuild=lambda p: rebuild.budget_snapshot(
                        p, taken_at=row["created_at"]))

    def current(self, budget_id: str) -> BudgetSnapshot:
        row = self._conn.execute(
            "SELECT current_snapshot_hash FROM budgets WHERE budget_id = ?",
            (budget_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError("budgets", budget_id)
        return self.get(row["current_snapshot_hash"])

    def history(self, budget_id: str) -> list[BudgetSnapshot]:
        rows = self._conn.execute(
            f"SELECT content_hash FROM {self.TABLE} WHERE budget_id = ? "
            "ORDER BY snapshot_version, created_at", (budget_id,)).fetchall()
        return [self.get(r["content_hash"]) for r in rows]


class SqlitePlanSnapshotStore(_Repo):
    TABLE = "plan_snapshots"

    def put(self, snapshot: PlanSnapshot) -> None:
        payload, digest = dump(snapshot)
        if self._conn.execute(f"SELECT 1 FROM {self.TABLE} WHERE content_hash = ?",
                              (digest,)).fetchone():
            return
        self._insert_append_only(self.TABLE, digest, {
            "content_hash": digest, "plan_id": snapshot.plan_id,
            "plan_version": snapshot.plan_version, "payload": payload,
            "created_at": self._now()})

    def get(self, content_hash: str) -> PlanSnapshot:
        row = self._conn.execute(
            f"SELECT payload, content_hash FROM {self.TABLE} WHERE content_hash = ?",
            (content_hash,)).fetchone()
        if row is None:
            raise RecordNotFoundError(self.TABLE, content_hash)
        payload = verify_only(row["payload"], row["content_hash"], table=self.TABLE,
                              entity_id=content_hash)
        # PlanSnapshot's payload is a projection of the plan, not the plan itself, so
        # it is returned verified rather than reconstructed into a live plan object.
        return PlanSnapshot(
            plan_id=payload["plan_id"], plan_version=payload["plan_version"],
            mode=payload["mode"], stages=[], model_ids=payload["model_ids"],
            deliverables=payload["deliverables"],
            stop_conditions=payload["stop_conditions"],
            exclusions=payload["exclusions"], tradeoffs=payload["tradeoffs"],
            human_tasks=payload["human_tasks"],
            estimator_ref=payload["estimator_ref"], scope_id=payload["scope_id"])


class SqliteApprovalStore(_Repo):
    def put_request(self, request) -> None:
        payload, digest = dump(request)
        self._insert_append_only("approval_requests", request.request_id, {
            "request_id": request.request_id, "content_hash": digest,
            "plan_id": request.plan_id, "purpose": request.purpose.value,
            "payload": payload, "created_at": self._now()})

    def put_decision(self, decision) -> None:
        payload, digest = dump(decision)
        self._insert_append_only("approvals", decision.decision_id, {
            "decision_id": decision.decision_id, "content_hash": digest,
            "request_id": decision.request_id, "approved": int(decision.approved),
            "approved_by": decision.approved_by, "decided_at": decision.decided_at,
            "payload": payload, "created_at": self._now()})

    def get_decision(self, decision_id: str):
        row = self._conn.execute(
            "SELECT payload, content_hash FROM approvals WHERE decision_id = ?",
            (decision_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError("approvals", decision_id)
        return load(row["payload"], row["content_hash"], table="approvals",
                    entity_id=decision_id, rebuild=rebuild.governed_approval)

    def decisions_for_request(self, request_id: str) -> list:
        rows = self._conn.execute(
            "SELECT decision_id FROM approvals WHERE request_id = ? "
            "ORDER BY created_at, decision_id", (request_id,)).fetchall()
        return [self.get_decision(r["decision_id"]) for r in rows]


class SqliteAuthorizationStore(_Repo):
    TABLE = "authorizations"

    def put(self, authorization: ExecutionAuthorization) -> None:
        payload, digest = dump(authorization)
        self._insert_append_only(self.TABLE, authorization.authorization_id, {
            "authorization_id": authorization.authorization_id,
            "content_hash": digest,
            "decision_id": authorization.approval_decision_id,
            "plan_id": authorization.plan_id,
            "purpose": authorization.purpose.value,
            "budget_snapshot_hash": authorization.budget_snapshot_hash,
            "payload": payload, "created_at": self._now()})

    def get(self, authorization_id: str) -> ExecutionAuthorization:
        row = self._conn.execute(
            f"SELECT payload, content_hash FROM {self.TABLE} "
            "WHERE authorization_id = ?", (authorization_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError(self.TABLE, authorization_id)
        return load(row["payload"], row["content_hash"], table=self.TABLE,
                    entity_id=authorization_id,
                    rebuild=rebuild.execution_authorization)

    def for_plan(self, plan_id: str) -> list[ExecutionAuthorization]:
        rows = self._conn.execute(
            f"SELECT authorization_id FROM {self.TABLE} WHERE plan_id = ? "
            "ORDER BY created_at", (plan_id,)).fetchall()
        return [self.get(r["authorization_id"]) for r in rows]


class SqliteReservationStore(_Repo):
    TABLE = "reservations"

    def put(self, reservation: SpendReservation) -> None:
        payload, digest = dump(reservation)
        now = self._now()
        self._insert_append_only(self.TABLE, reservation.reservation_id, {
            "reservation_id": reservation.reservation_id,
            "budget_id": reservation.budget_id,
            "authorization_id": reservation.authorization_id,
            "plan_id": reservation.plan_id,
            "idempotency_key": reservation.idempotency_key,
            "status": reservation.status.value, "content_hash": digest,
            "payload": payload, "created_at": now, "updated_at": now})
        self._append_history(reservation, digest, payload, now)

    def advance(self, reservation: SpendReservation) -> None:
        """Store a status advance. The previous state stays in ``reservation_history``."""
        payload, digest = dump(reservation)
        now = self._now()
        cursor = self._conn.execute(
            f"UPDATE {self.TABLE} SET status = ?, content_hash = ?, payload = ?, "
            "updated_at = ? WHERE reservation_id = ?",
            (reservation.status.value, digest, payload, now,
             reservation.reservation_id))
        if cursor.rowcount == 0:
            raise RecordNotFoundError(self.TABLE, reservation.reservation_id)
        self._append_history(reservation, digest, payload, now)

    def _append_history(self, reservation: SpendReservation, digest: str,
                        payload: str, at: str) -> None:
        self._conn.execute(
            "INSERT INTO reservation_history "
            "(reservation_id, status, content_hash, payload, recorded_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (reservation.reservation_id, reservation.status.value, digest, payload, at))

    def _rebuild_row(self, row, entity_id: str) -> SpendReservation:
        return load(row["payload"], row["content_hash"], table=self.TABLE,
                    entity_id=entity_id, rebuild=rebuild.spend_reservation)

    def get(self, reservation_id: str) -> SpendReservation:
        row = self._conn.execute(
            f"SELECT payload, content_hash FROM {self.TABLE} WHERE reservation_id = ?",
            (reservation_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError(self.TABLE, reservation_id)
        return self._rebuild_row(row, reservation_id)

    def by_idempotency_key(self, budget_id: str,
                           key: str) -> Optional[SpendReservation]:
        row = self._conn.execute(
            f"SELECT reservation_id FROM {self.TABLE} "
            "WHERE budget_id = ? AND idempotency_key = ?", (budget_id, key)).fetchone()
        return None if row is None else self.get(row["reservation_id"])

    def open_for_budget(self, budget_id: str) -> list[SpendReservation]:
        rows = self._conn.execute(
            f"SELECT reservation_id FROM {self.TABLE} "
            "WHERE budget_id = ? AND status IN ('proposed','committed','ambiguous') "
            "ORDER BY created_at", (budget_id,)).fetchall()
        return [self.get(r["reservation_id"]) for r in rows]

    def ambiguous_for_budget(self, budget_id: str) -> list[SpendReservation]:
        """Ambiguous holds survive restart and are never released automatically."""
        rows = self._conn.execute(
            f"SELECT reservation_id FROM {self.TABLE} "
            "WHERE budget_id = ? AND status = 'ambiguous' ORDER BY created_at",
            (budget_id,)).fetchall()
        return [self.get(r["reservation_id"]) for r in rows]

    def history(self, reservation_id: str) -> list[SpendReservation]:
        rows = self._conn.execute(
            "SELECT payload, content_hash FROM reservation_history "
            "WHERE reservation_id = ? ORDER BY id", (reservation_id,)).fetchall()
        return [self._rebuild_row(r, reservation_id) for r in rows]


class SqliteSettlementStore(_Repo):
    TABLE = "settlements"

    def put(self, result: SettlementResult) -> None:
        payload, digest = dump(result)
        self._insert_append_only(self.TABLE, result.reservation_id, {
            "reservation_id": result.reservation_id, "content_hash": digest,
            "review_required": int(result.review_required), "payload": payload,
            "created_at": self._now()})

    def get(self, reservation_id: str) -> SettlementResult:
        row = self._conn.execute(
            f"SELECT payload, content_hash FROM {self.TABLE} WHERE reservation_id = ?",
            (reservation_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError(self.TABLE, reservation_id)
        return load(row["payload"], row["content_hash"], table=self.TABLE,
                    entity_id=reservation_id, rebuild=rebuild.settlement_result)

    def requiring_review(self) -> list[SettlementResult]:
        rows = self._conn.execute(
            f"SELECT reservation_id FROM {self.TABLE} WHERE review_required = 1 "
            "ORDER BY created_at").fetchall()
        return [self.get(r["reservation_id"]) for r in rows]


class SqliteOverrideStore(_Repo):
    TABLE = "overrides"

    def put(self, override: BudgetOverride, *, budget_id: str) -> None:
        payload, digest = dump(override)
        self._insert_append_only(self.TABLE, override.override_id, {
            "override_id": override.override_id, "content_hash": digest,
            "budget_id": budget_id, "actor": override.actor,
            "payload": payload, "created_at": self._now()})

    def get(self, override_id: str) -> BudgetOverride:
        row = self._conn.execute(
            f"SELECT payload, content_hash FROM {self.TABLE} WHERE override_id = ?",
            (override_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError(self.TABLE, override_id)
        return load(row["payload"], row["content_hash"], table=self.TABLE,
                    entity_id=override_id, rebuild=rebuild.budget_override)

    def for_budget(self, budget_id: str) -> list[BudgetOverride]:
        rows = self._conn.execute(
            f"SELECT override_id FROM {self.TABLE} WHERE budget_id = ? "
            "ORDER BY created_at", (budget_id,)).fetchall()
        return [self.get(r["override_id"]) for r in rows]


class SqliteGovernanceEventStore(_Repo):
    TABLE = "governance_events"

    def append(self, event: GovernanceEvent) -> None:
        payload, digest = dump(event)
        self._conn.execute(
            f"INSERT INTO {self.TABLE} (content_hash, event_type, plan_id, budget_id, "
            "occurred_at, payload, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (digest, event.event_type.value, event.plan_id, event.budget_id,
             event.occurred_at, payload, self._now()))

    def _rows(self, where: str, params: tuple) -> list[GovernanceEvent]:
        rows = self._conn.execute(
            f"SELECT id, payload, content_hash FROM {self.TABLE} {where} ORDER BY id",
            params).fetchall()
        return [load(r["payload"], r["content_hash"], table=self.TABLE,
                     entity_id=str(r["id"]), rebuild=rebuild.governance_event)
                for r in rows]

    def for_plan(self, plan_id: str) -> list[GovernanceEvent]:
        return self._rows("WHERE plan_id = ?", (plan_id,))

    def for_budget(self, budget_id: str) -> list[GovernanceEvent]:
        return self._rows("WHERE budget_id = ?", (budget_id,))

    def all(self) -> list[GovernanceEvent]:
        return self._rows("", ())


class SqliteIdempotencyStore(_Repo):
    TABLE = "idempotency_keys"

    def record(self, *, key: str, operation: str, request_hash: str,
               entity_id: str, entity_hash: str) -> None:
        self._conn.execute(
            f"INSERT INTO {self.TABLE} (idempotency_key, operation, "
            "canonical_request_hash, result_entity_id, result_entity_hash, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (key, operation, request_hash, entity_id, entity_hash, self._now()))

    def lookup(self, *, key: str,
               operation: str) -> Optional[tuple[str, str, str]]:
        """``(request_hash, entity_id, entity_hash)`` if the key has been used."""
        row = self._conn.execute(
            f"SELECT canonical_request_hash, result_entity_id, result_entity_hash "
            f"FROM {self.TABLE} WHERE idempotency_key = ? AND operation = ?",
            (key, operation)).fetchone()
        if row is None:
            return None
        return (row["canonical_request_hash"], row["result_entity_id"],
                row["result_entity_hash"])


class SqliteAdmissionStore(_Repo):
    """Admissions are stored for audit; they are re-derived, never re-executed."""

    TABLE = "admissions"

    def put(self, admission) -> None:
        payload, digest = dump(admission)
        self._insert_append_only(self.TABLE, admission.admission_id, {
            "admission_id": admission.admission_id, "content_hash": digest,
            "purpose": admission.purpose.value,
            "plan_snapshot_hash": admission.plan_snapshot_hash,
            "budget_snapshot_hash": admission.budget_snapshot_hash,
            "admitted": int(admission.admitted), "payload": payload,
            "created_at": self._now()})

    def payload_of(self, admission_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            f"SELECT payload, content_hash FROM {self.TABLE} WHERE admission_id = ?",
            (admission_id,)).fetchone()
        if row is None:
            raise RecordNotFoundError(self.TABLE, admission_id)
        return verify_only(row["payload"], row["content_hash"], table=self.TABLE,
                           entity_id=admission_id)
