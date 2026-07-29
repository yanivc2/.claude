"""P1d: transactional persistence — recovery, concurrency, crash consistency.

Offline and local. The only I/O is a temporary SQLite file per test.

Concurrency is tested with **two separate connections**, not two sequential calls on
one: a single connection cannot exhibit the race this layer exists to prevent, so
testing it that way would prove nothing.
"""
from __future__ import annotations

import sqlite3
from decimal import Decimal
from pathlib import Path

import pytest

from meta_orchestrator.planner.contracts.budget import (
    BudgetPolicy,
    BudgetState,
    HardBudgetCap,
)
from meta_orchestrator.planner.contracts.money import Money
from meta_orchestrator.planner.contracts.plan import ExecutionMode
from meta_orchestrator.planner.governance import (
    ApprovalBinding,
    BudgetOverride,
    BudgetSnapshot,
    ExecutionAuthorization,
    GovernanceEventType,
    IdempotencyConflictError,
    SpendPurpose,
    SpendReservationStatus,
    StaleSnapshotError,
    UsageCeiling,
)
from meta_orchestrator.planner.governance.gate import (
    GovernedApproval,
    GovernedApprovalRequest,
)
from meta_orchestrator.planner.persistence import (
    APPEND_ONLY_TABLES,
    CANONICAL_SERIALIZATION_VERSION,
    SCHEMA_VERSION,
    AppendOnlyViolationError,
    BudgetService,
    ConcurrentBudgetModificationError,
    CorruptRecordError,
    FixedClock,
    GovernanceStore,
    RecordNotFoundError,
    SchemaVersionMismatchError,
    TransactionError,
    connect,
    initialize,
    migrate,
    open_existing,
    verify_schema,
)
from meta_orchestrator.planner.persistence.errors import InjectedFaultError

NOW = "2026-07-29T12:00:00Z"
USD = "USD"


def m(v: str) -> Money:
    return Money(amount=Decimal(v), currency=USD)


@pytest.fixture
def db_path(tmp_path: Path) -> str:
    return str(tmp_path / "governance.db")


@pytest.fixture
def store(db_path: str) -> GovernanceStore:
    s = GovernanceStore(db_path, clock=FixedClock(NOW))
    yield s
    s.close()


def _policy(limit: str = "100") -> BudgetPolicy:
    return BudgetPolicy(policy_id="pol1", cap=HardBudgetCap(limit=m(limit)),
                        policy_hash="ph1")


def _snapshot(limit: str = "100", *, actual: str = "0",
              committed: str = "0") -> BudgetSnapshot:
    return BudgetSnapshot.of(
        _policy(limit),
        BudgetState(plan_id="p1", policy_id="pol1", committed=m(committed),
                    actual=m(actual)),
        budget_id="b1", taken_at=NOW)


def _binding(snapshot: BudgetSnapshot) -> ApprovalBinding:
    return ApprovalBinding(
        plan_hash="a" * 64, plan_version=1, estimate_audit_hash="b" * 64,
        estimator_version="1.0.0", ruleset_version="rules-v1",
        projection_hash="c" * 64, price_card_id="card",
        price_card_content_hash="d" * 64, pricing_catalog_version="cat",
        budget_policy_hash="ph1", budget_snapshot_hash=snapshot.content_hash(),
        admission_hash="e" * 64, purpose=SpendPurpose.REAL_SPEND,
        execution_mode=ExecutionMode.AUTOMATIC, reserve_policy_hash="f" * 64,
        approved_commitment="10")


def _authorization(snapshot: BudgetSnapshot, **over) -> ExecutionAuthorization:
    base = dict(
        authorization_id="auth1", purpose=SpendPurpose.REAL_SPEND,
        binding=_binding(snapshot), plan_id="p1", plan_version=1,
        approval_decision_id="d1", admission_id="e" * 64,
        budget_snapshot_hash=snapshot.content_hash(), budget_id="b1",
        approved_commitment=m("10"), reserve_amount=m("0"), currency=USD,
        permitted_provider="anthropic", permitted_model_id="claude-haiku-4-5",
        permitted_mode=ExecutionMode.AUTOMATIC,
        usage_ceiling=UsageCeiling(max_calls=4), valid_from=NOW, issued_by="yaniv")
    base.update(over)
    return ExecutionAuthorization(**base)


def _seed(store: GovernanceStore, *, limit: str = "100"
          ) -> tuple[BudgetSnapshot, ExecutionAuthorization]:
    """Register a budget and the full approval chain an authorization needs."""
    snapshot = _snapshot(limit)
    binding = _binding(snapshot)
    request = GovernedApprovalRequest(
        request_id="req1", purpose=SpendPurpose.REAL_SPEND, binding=binding,
        plan_id="p1", plan_version=1, summary="a plan",
        deliverables=["a repaired module"], expected_cost=m("8"),
        worst_reasonable_cost=m("10"), reserve_amount=m("0"),
        proposed_commitment=m("10"), currency=USD)
    decision = GovernedApproval(
        decision_id="d1", request_id="req1", approved=True, approved_by="yaniv",
        decided_at=NOW, binding=binding, approved_commitment=m("10"))
    authorization = _authorization(snapshot)
    with store.unit_of_work() as uow:
        uow.register_budget(snapshot)
        uow.approvals.put_request(request)
        uow.approvals.put_decision(decision)
        uow.authorizations.put(authorization)
    return snapshot, authorization


# =========================================================================== #
# Schema and migrations
# =========================================================================== #

def test_initialisation_creates_the_schema(store: GovernanceStore):
    assert store.schema_version == SCHEMA_VERSION
    assert store.serialization_version == CANONICAL_SERIALIZATION_VERSION
    verify_schema(store.connection)


def test_migration_is_idempotent(db_path: str):
    conn = initialize(db_path, clock=FixedClock(NOW))
    assert migrate(conn, clock=FixedClock(NOW)) == []      # nothing left to apply
    verify_schema(conn)
    conn.close()


def test_an_uninitialised_database_is_refused_rather_than_migrated(db_path: str):
    """No implicit migration: an unnoticed one rewrites a ledger nobody was watching."""
    conn = connect(db_path)
    with pytest.raises(SchemaVersionMismatchError, match="uninitialised"):
        verify_schema(conn)
    conn.close()


def test_a_wrong_schema_version_is_refused(db_path: str):
    conn = initialize(db_path, clock=FixedClock(NOW))
    conn.execute("UPDATE schema_migrations SET version = 'something_else'")
    with pytest.raises(SchemaVersionMismatchError, match="something_else"):
        verify_schema(conn)
    conn.close()


def test_open_existing_does_not_create(db_path: str):
    with pytest.raises(SchemaVersionMismatchError):
        open_existing(db_path)


def test_foreign_keys_and_pragmas_are_on(store: GovernanceStore):
    assert store.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert store.connection.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert store.connection.execute("PRAGMA busy_timeout").fetchone()[0] == 5000


def test_a_foreign_key_violation_is_enforced(store: GovernanceStore):
    """Proof the constraint is live, not merely declared."""
    with pytest.raises(sqlite3.IntegrityError):
        store.connection.execute(
            "INSERT INTO budget_snapshots (content_hash, budget_id, snapshot_version, "
            "payload, created_at) VALUES ('x', 'no-such-budget', 1, '{}', ?)", (NOW,))


# =========================================================================== #
# Round-trip and integrity
# =========================================================================== #

def test_a_snapshot_round_trips_through_storage(store: GovernanceStore):
    snapshot, _ = _seed(store)
    loaded = store.budgets.get(snapshot.content_hash())
    assert loaded.content_hash() == snapshot.content_hash()
    assert loaded.effective_cap == snapshot.effective_cap


def test_an_authorization_round_trips_with_its_scope(store: GovernanceStore):
    _, auth = _seed(store)
    loaded = store.authorizations.get("auth1")
    assert loaded.content_hash() == auth.content_hash()
    assert loaded.permitted_model_id == "claude-haiku-4-5"
    assert loaded.usage_ceiling.max_calls == 4
    assert loaded.budget_id == "b1"


def test_an_approval_round_trips_with_its_binding(store: GovernanceStore):
    _seed(store)
    decision = store.approvals.get_decision("d1")
    assert decision.approved is True
    assert decision.binding.plan_hash == "a" * 64


def test_a_tampered_payload_is_refused(store: GovernanceStore):
    snapshot, _ = _seed(store)
    store.connection.execute(
        "UPDATE budget_snapshots SET payload = json_set(payload, '$.currency', 'ILS') "
        "WHERE content_hash = ?", (snapshot.content_hash(),))
    with pytest.raises(CorruptRecordError, match="may have been altered"):
        store.budgets.get(snapshot.content_hash())


def test_a_tampered_hash_is_refused(store: GovernanceStore):
    snapshot, _ = _seed(store)
    store.connection.execute(
        "UPDATE budget_snapshots SET content_hash = ? WHERE content_hash = ?",
        ("0" * 64, snapshot.content_hash()))
    with pytest.raises(CorruptRecordError):
        store.budgets.get("0" * 64)


def test_a_missing_record_raises_rather_than_returning_none(store: GovernanceStore):
    with pytest.raises(RecordNotFoundError):
        store.authorizations.get("no-such-auth")


# =========================================================================== #
# Append-only
# =========================================================================== #

def test_the_append_only_tables_are_declared():
    for table in ("approvals", "authorizations", "overrides", "settlements",
                  "governance_events"):
        assert table in APPEND_ONLY_TABLES


def test_an_approval_cannot_be_rewritten(store: GovernanceStore):
    snapshot, _ = _seed(store)
    decision = store.approvals.get_decision("d1")
    with store.unit_of_work() as uow:
        with pytest.raises(AppendOnlyViolationError, match="append-only"):
            uow.approvals.put_decision(decision)


def test_an_authorization_cannot_be_rewritten(store: GovernanceStore):
    _, auth = _seed(store)
    with store.unit_of_work() as uow:
        with pytest.raises(AppendOnlyViolationError):
            uow.authorizations.put(auth)


def test_approval_history_survives_a_supersession(store: GovernanceStore):
    """A changed mind is a new record; the original stays readable."""
    snapshot, _ = _seed(store)
    superseded = store.approvals.get_decision("d1").model_copy(
        update={"decision_id": "d1::superseded", "approved": False,
                "reason": "plan re-estimated"})
    with store.unit_of_work() as uow:
        uow.approvals.put_decision(superseded)
    both = store.approvals.decisions_for_request("req1")
    assert {d.decision_id for d in both} == {"d1", "d1::superseded"}
    assert store.approvals.get_decision("d1").approved is True


# =========================================================================== #
# Atomic reservation
# =========================================================================== #

def test_a_reservation_and_the_balance_move_together(store: GovernanceStore):
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    reservation = service.reserve(
        authorization=auth, reservation_id="res1", idempotency_key="k1",
        amount=m("10"), reserve_component=m("0"),
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)

    assert reservation.status is SpendReservationStatus.COMMITTED
    current = store.budgets.current("b1")
    assert current.committed_spend == m("10")
    assert current.snapshot_version == snapshot.snapshot_version + 1


def test_reserving_exactly_to_the_cap_succeeds(store: GovernanceStore):
    snapshot, auth = _seed(store, limit="10")
    BudgetService(store).reserve(
        authorization=auth, reservation_id="res1", idempotency_key="k1",
        amount=m("10"), reserve_component=m("0"),
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    assert store.budgets.current("b1").remaining == Money.zero(USD)


def test_reserving_a_penny_over_the_cap_fails_and_writes_nothing(store: GovernanceStore):
    from meta_orchestrator.planner.budget.errors import InsufficientBudgetError

    snapshot, auth = _seed(store, limit="10")
    with pytest.raises(InsufficientBudgetError):
        BudgetService(store).reserve(
            authorization=auth, reservation_id="res1", idempotency_key="k1",
            amount=m("10.01"), reserve_component=m("0"),
            expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    assert store.budgets.current("b1").committed_spend == Money.zero(USD)
    assert store.reservations.open_for_budget("b1") == []


def test_a_stale_expected_snapshot_is_refused(store: GovernanceStore):
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    # The caller still holds the original snapshot; the budget has moved on.
    with pytest.raises(StaleSnapshotError):
        service.reserve(authorization=auth, reservation_id="res2",
                        idempotency_key="k2", amount=m("5"),
                        reserve_component=m("0"),
                        expected_snapshot_hash=snapshot.content_hash(), at=NOW)


# =========================================================================== #
# Idempotency
# =========================================================================== #

def test_an_identical_retry_does_not_reserve_twice(store: GovernanceStore):
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    first = service.reserve(
        authorization=auth, reservation_id="res1", idempotency_key="k1",
        amount=m("10"), reserve_component=m("0"),
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    again = service.reserve(
        authorization=auth, reservation_id="res-different", idempotency_key="k1",
        amount=m("10"), reserve_component=m("0"),
        expected_snapshot_hash=store.budgets.current("b1").content_hash(), at=NOW)
    assert again.reservation_id == first.reservation_id
    assert store.budgets.current("b1").committed_spend == m("10")


def test_the_same_key_with_a_different_amount_fails(store: GovernanceStore):
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    with pytest.raises(IdempotencyConflictError):
        service.reserve(authorization=auth, reservation_id="res2",
                        idempotency_key="k1", amount=m("20"),
                        reserve_component=m("0"),
                        expected_snapshot_hash=store.budgets.current("b1").content_hash(),
                        at=NOW)


# =========================================================================== #
# Concurrency — two real connections
# =========================================================================== #

def test_two_connections_cannot_both_reserve_the_same_remaining_amount(db_path: str):
    """The race this layer exists to prevent, exercised with two live connections."""
    first = GovernanceStore(db_path, clock=FixedClock(NOW))
    snapshot, auth = _seed(first, limit="10")

    second = GovernanceStore(db_path, clock=FixedClock(NOW), create=False)
    try:
        BudgetService(first).reserve(
            authorization=auth, reservation_id="res-a", idempotency_key="ka",
            amount=m("10"), reserve_component=m("0"),
            expected_snapshot_hash=snapshot.content_hash(), at=NOW)

        # The second caller decided against the same snapshot and is now behind.
        with pytest.raises((StaleSnapshotError, ConcurrentBudgetModificationError)):
            BudgetService(second).reserve(
                authorization=auth, reservation_id="res-b", idempotency_key="kb",
                amount=m("10"), reserve_component=m("0"),
                expected_snapshot_hash=snapshot.content_hash(), at=NOW)

        assert second.budgets.current("b1").committed_spend == m("10")
        assert len(second.reservations.open_for_budget("b1")) == 1
    finally:
        first.close()
        second.close()


def test_a_compare_and_swap_against_a_moved_budget_raises(store: GovernanceStore):
    snapshot, _ = _seed(store)
    moved = _snapshot(actual="5")
    with pytest.raises(ConcurrentBudgetModificationError, match="re-read and re-decide"):
        with store.unit_of_work() as uow:
            uow.compare_and_swap_budget(budget_id="b1", expected_hash="0" * 64,
                                        new_snapshot=moved)


def test_units_of_work_do_not_nest(store: GovernanceStore):
    with store.unit_of_work():
        with pytest.raises(TransactionError, match="do not nest"):
            with store.unit_of_work():
                pass


# =========================================================================== #
# Crash consistency
# =========================================================================== #

@pytest.mark.parametrize("fault", [
    "after_reservation_insert", "after_snapshot_update", "after_event_append",
    "before_commit",
])
def test_an_injected_fault_leaves_nothing_behind(db_path: str, fault: str):
    """Whatever point it fails at, the transaction leaves no partial state."""
    store = GovernanceStore(db_path, clock=FixedClock(NOW))
    try:
        snapshot, auth = _seed(store)
        store.arm_fault(fault)
        with pytest.raises(InjectedFaultError):
            BudgetService(store).reserve(
                authorization=auth, reservation_id="res1", idempotency_key="k1",
                amount=m("10"), reserve_component=m("0"),
                expected_snapshot_hash=snapshot.content_hash(), at=NOW)

        assert store.budgets.current("b1").content_hash() == snapshot.content_hash()
        assert store.reservations.open_for_budget("b1") == []
        assert store.events.for_budget("b1") == []
        assert store.idempotency.lookup(key="k1", operation="reserve") is None
    finally:
        store.disarm_faults()
        store.close()


def test_the_rollback_is_visible_to_a_fresh_connection(db_path: str):
    """A rolled-back write must not be readable after a restart either."""
    store = GovernanceStore(db_path, clock=FixedClock(NOW))
    snapshot, auth = _seed(store)
    store.arm_fault("after_snapshot_update")
    with pytest.raises(InjectedFaultError):
        BudgetService(store).reserve(
            authorization=auth, reservation_id="res1", idempotency_key="k1",
            amount=m("10"), reserve_component=m("0"),
            expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    store.disarm_faults()
    store.close()

    reopened = GovernanceStore(db_path, clock=FixedClock(NOW), create=False)
    try:
        assert reopened.budgets.current("b1").committed_spend == Money.zero(USD)
        assert reopened.reservations.open_for_budget("b1") == []
    finally:
        reopened.close()


# =========================================================================== #
# Restart recovery
# =========================================================================== #

def _reserve_then_restart(db_path: str, *, amount: str = "10"):
    store = GovernanceStore(db_path, clock=FixedClock(NOW))
    snapshot, auth = _seed(store)
    BudgetService(store).reserve(
        authorization=auth, reservation_id="res1", idempotency_key="k1",
        amount=m(amount), reserve_component=m("0"),
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    store.close()
    return GovernanceStore(db_path, clock=FixedClock(NOW), create=False)


def test_a_reservation_survives_a_restart(db_path: str):
    reopened = _reserve_then_restart(db_path)
    try:
        reservation = reopened.reservations.get("res1")
        assert reservation.status is SpendReservationStatus.COMMITTED
        assert reservation.amount == m("10")
        assert reopened.budgets.current("b1").committed_spend == m("10")
    finally:
        reopened.close()


def test_an_approval_and_authorization_survive_a_restart(db_path: str):
    reopened = _reserve_then_restart(db_path)
    try:
        assert reopened.approvals.get_decision("d1").approved is True
        auth = reopened.authorizations.get("auth1")
        assert auth.approved_commitment == m("10")
        assert auth.content_hash()          # rebuilt and re-hashed cleanly
    finally:
        reopened.close()


def test_idempotency_survives_a_restart(db_path: str):
    """An in-memory map forgets exactly when it matters — after the restart."""
    reopened = _reserve_then_restart(db_path)
    try:
        assert reopened.idempotency.lookup(key="k1", operation="reserve") is not None
        auth = reopened.authorizations.get("auth1")
        again = BudgetService(reopened).reserve(
            authorization=auth, reservation_id="res-other", idempotency_key="k1",
            amount=m("10"), reserve_component=m("0"),
            expected_snapshot_hash=reopened.budgets.current("b1").content_hash(),
            at=NOW)
        assert again.reservation_id == "res1"
        assert reopened.budgets.current("b1").committed_spend == m("10")
    finally:
        reopened.close()


def test_a_reservation_can_be_settled_after_a_restart(db_path: str):
    reopened = _reserve_then_restart(db_path)
    try:
        result = BudgetService(reopened).settle(
            reservation_id="res1", actual=m("6"),
            expected_snapshot_hash=reopened.budgets.current("b1").content_hash(),
            at=NOW)
        assert result.review_required is False
        current = reopened.budgets.current("b1")
        assert current.actual_spend == m("6")
        assert current.committed_spend == Money.zero(USD)
    finally:
        reopened.close()


def test_events_survive_a_restart_and_re_verify(db_path: str):
    reopened = _reserve_then_restart(db_path)
    try:
        events = reopened.events.for_budget("b1")
        assert [e.event_type for e in events] == [
            GovernanceEventType.RESERVATION_COMMITTED]
        assert len(events[0].content_hash()) == 64
    finally:
        reopened.close()


# =========================================================================== #
# Ambiguity
# =========================================================================== #

def test_an_ambiguous_hold_survives_a_restart_and_is_not_released(db_path: str):
    store = GovernanceStore(db_path, clock=FixedClock(NOW))
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    service.mark_ambiguous(reservation_id="res1", reason="connection dropped after send",
                           at=NOW)
    store.close()

    reopened = GovernanceStore(db_path, clock=FixedClock(NOW), create=False)
    try:
        reservation = reopened.reservations.get("res1")
        assert reservation.status is SpendReservationStatus.AMBIGUOUS
        # The money is still held — releasing it would let it be spent twice.
        assert reopened.budgets.current("b1").committed_spend == m("10")
        assert reopened.reservations.ambiguous_for_budget("b1")[0].reservation_id == "res1"
    finally:
        reopened.close()


def test_resolving_an_ambiguous_call_requires_an_actor(store: GovernanceStore):
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    service.mark_ambiguous(reservation_id="res1", reason="unknown", at=NOW)
    with pytest.raises(ValueError, match="must name who decided"):
        service.resolve_ambiguous(
            reservation_id="res1", was_billed=False, actual=None, resolved_by="  ",
            reason="x",
            expected_snapshot_hash=store.budgets.current("b1").content_hash(), at=NOW)


def test_resolving_an_ambiguous_call_as_billed_settles_it(store: GovernanceStore):
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    service.mark_ambiguous(reservation_id="res1", reason="unknown", at=NOW)
    service.resolve_ambiguous(
        reservation_id="res1", was_billed=True, actual=m("9"), resolved_by="yaniv",
        reason="provider confirmed", at=NOW,
        expected_snapshot_hash=store.budgets.current("b1").content_hash())
    current = store.budgets.current("b1")
    assert current.actual_spend == m("9")
    assert current.committed_spend == Money.zero(USD)


# =========================================================================== #
# Settlement and overrun
# =========================================================================== #

def test_settlement_moves_committed_to_actual_in_one_transaction(store: GovernanceStore):
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    service.settle(reservation_id="res1", actual=m("4"),
                   expected_snapshot_hash=store.budgets.current("b1").content_hash(),
                   at=NOW)
    current = store.budgets.current("b1")
    assert (current.committed_spend, current.actual_spend) == (Money.zero(USD), m("4"))


def test_an_overrun_does_not_settle_and_does_not_move_the_budget(store: GovernanceStore):
    """Absorbing an overrun silently is the same as having no cap."""
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    before = store.budgets.current("b1")

    result = service.settle(reservation_id="res1", actual=m("15"),
                            expected_snapshot_hash=before.content_hash(), at=NOW)
    assert result.review_required is True
    assert result.overrun == m("5")

    after = store.budgets.current("b1")
    assert after.content_hash() == before.content_hash()      # budget untouched
    assert after.effective_cap == m("100")                    # cap not widened
    assert store.reservations.get("res1").status is SpendReservationStatus.COMMITTED
    assert GovernanceEventType.OVERRUN_DETECTED in [
        e.event_type for e in store.events.for_budget("b1")]


def test_a_settled_reservation_cannot_be_settled_again_after_restart(db_path: str):
    from meta_orchestrator.planner.governance import InvalidReservationTransitionError

    store = GovernanceStore(db_path, clock=FixedClock(NOW))
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    service.settle(reservation_id="res1", actual=m("4"),
                   expected_snapshot_hash=store.budgets.current("b1").content_hash(),
                   at=NOW)
    store.close()

    reopened = GovernanceStore(db_path, clock=FixedClock(NOW), create=False)
    try:
        with pytest.raises(InvalidReservationTransitionError, match="settled ->"):
            BudgetService(reopened).settle(
                reservation_id="res1", actual=m("4"),
                expected_snapshot_hash=reopened.budgets.current("b1").content_hash(),
                at=NOW)
    finally:
        reopened.close()


def test_release_after_settle_is_refused_after_restart(db_path: str):
    from meta_orchestrator.planner.governance import InvalidReservationTransitionError

    store = GovernanceStore(db_path, clock=FixedClock(NOW))
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    service.settle(reservation_id="res1", actual=m("4"),
                   expected_snapshot_hash=store.budgets.current("b1").content_hash(),
                   at=NOW)
    store.close()

    reopened = GovernanceStore(db_path, clock=FixedClock(NOW), create=False)
    try:
        with pytest.raises(InvalidReservationTransitionError):
            BudgetService(reopened).release(
                reservation_id="res1", reason="changed my mind",
                expected_snapshot_hash=reopened.budgets.current("b1").content_hash(),
                at=NOW)
    finally:
        reopened.close()


def test_reservation_history_records_every_step(store: GovernanceStore):
    snapshot, auth = _seed(store)
    service = BudgetService(store)
    service.reserve(authorization=auth, reservation_id="res1", idempotency_key="k1",
                    amount=m("10"), reserve_component=m("0"),
                    expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    service.settle(reservation_id="res1", actual=m("4"),
                   expected_snapshot_hash=store.budgets.current("b1").content_hash(),
                   at=NOW)
    statuses = [r.status for r in store.reservations.history("res1")]
    assert statuses == [SpendReservationStatus.COMMITTED,
                        SpendReservationStatus.SETTLED]


# =========================================================================== #
# Override
# =========================================================================== #

def _override(current: BudgetSnapshot) -> BudgetOverride:
    return BudgetOverride(
        override_id="o1", actor="yaniv", reason="the run is worth finishing",
        original_cap=current.effective_cap, new_cap=m("150"), currency=USD,
        bound_plan_hash="a" * 64, bound_admission_hash="e" * 64,
        approval_decision_id="d1", granted_at=NOW)


def test_an_override_creates_a_new_snapshot_and_raises_the_cap(store: GovernanceStore):
    snapshot, _ = _seed(store)
    outcome = BudgetService(store).apply_override(
        override=_override(snapshot), budget_id="b1",
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    current = store.budgets.current("b1")
    assert current.effective_cap == m("150")
    assert current.content_hash() == outcome.new_snapshot_hash
    assert current.content_hash() != snapshot.content_hash()
    assert "o1" in current.approved_override_ids


def test_an_override_invalidates_the_prior_authorization(store: GovernanceStore):
    """The chain breaks at the snapshot, which is the intended consequence."""
    snapshot, auth = _seed(store)
    BudgetService(store).apply_override(
        override=_override(snapshot), budget_id="b1",
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    assert auth.budget_snapshot_hash != store.budgets.current("b1").content_hash()
    with pytest.raises(StaleSnapshotError):
        BudgetService(store).reserve(
            authorization=auth, reservation_id="res1", idempotency_key="k1",
            amount=m("10"), reserve_component=m("0"),
            expected_snapshot_hash=auth.budget_snapshot_hash, at=NOW)


def test_an_override_survives_a_restart(db_path: str):
    store = GovernanceStore(db_path, clock=FixedClock(NOW))
    snapshot, _ = _seed(store)
    BudgetService(store).apply_override(
        override=_override(snapshot), budget_id="b1",
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    store.close()

    reopened = GovernanceStore(db_path, clock=FixedClock(NOW), create=False)
    try:
        assert reopened.overrides.get("o1").new_cap == m("150")
        assert reopened.budgets.current("b1").effective_cap == m("150")
    finally:
        reopened.close()


def test_an_override_must_raise_the_effective_cap(store: GovernanceStore):
    snapshot, _ = _seed(store)
    lowering = _override(snapshot).model_copy(update={"new_cap": m("100")})
    with pytest.raises(ValueError, match="must raise the effective cap"):
        BudgetService(store).apply_override(
            override=lowering, budget_id="b1",
            expected_snapshot_hash=snapshot.content_hash(), at=NOW)


# =========================================================================== #
# Security and boundaries
# =========================================================================== #

def _persistence_modules():
    pkg = (Path(__file__).resolve().parents[1] / "src" / "meta_orchestrator"
           / "planner" / "persistence")
    return sorted(pkg.glob("*.py"))


#: The only things an f-string in a SQL statement may interpolate: structural
#: identifiers built from module constants or from dict keys the code itself supplied.
#: Every *value* travels as a bound parameter.
_ALLOWED_SQL_INTERPOLATIONS = {"TABLE", "table", "names", "holes", "where"}


def test_only_structural_identifiers_are_interpolated_into_sql():
    """Values are always bound parameters; identifiers may be interpolated.

    Checked by name rather than by scanning for '?', because the placeholders
    themselves are built structurally — a text search would flag correct code and miss
    the one line that mattered.
    """
    import ast

    keywords = ("SELECT ", "INSERT INTO", "UPDATE ", "DELETE FROM", " FROM ", " WHERE ")
    offenders = []
    for path in _persistence_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.JoinedStr):
                continue
            literal = "".join(p.value for p in node.values
                              if isinstance(p, ast.Constant) and isinstance(p.value, str))
            if not any(k in literal.upper() for k in keywords):
                continue                       # not a SQL statement
            for part in node.values:
                if not isinstance(part, ast.FormattedValue):
                    continue
                expr = part.value
                name = (expr.attr if isinstance(expr, ast.Attribute)
                        else expr.id if isinstance(expr, ast.Name) else "<expr>")
                if name not in _ALLOWED_SQL_INTERPOLATIONS:
                    offenders.append(f"{path.name}:{node.lineno} interpolates {name!r}")
    assert offenders == [], f"non-structural interpolation into SQL: {offenders}"


def test_every_value_carrying_statement_binds_its_parameters():
    """No execute() with a WHERE/VALUES clause may omit its parameter tuple."""
    import ast

    offenders = []
    for path in _persistence_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "execute"):
                continue
            first = node.args[0] if node.args else None
            text = ""
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                text = first.value
            elif isinstance(first, ast.JoinedStr):
                text = "".join(p.value for p in first.values
                               if isinstance(p, ast.Constant))
            if "?" in text and len(node.args) < 2:
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == [], f"placeholders without bound parameters: {offenders}"


def test_persistence_does_not_import_the_frozen_experiment_tree():
    import ast

    offenders = []
    for path in _persistence_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                     else [node.module or ""] if isinstance(node, ast.ImportFrom)
                     else [])
            if any("experiment" in n for n in names):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []


def test_persistence_makes_no_network_calls():
    import ast

    banned = {"socket", "http", "httpx", "requests", "urllib", "anthropic", "ssl"}
    offenders = []
    for path in _persistence_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names = ([a.name.split(".")[0] for a in node.names]
                     if isinstance(node, ast.Import)
                     else [(node.module or "").split(".")[0]]
                     if isinstance(node, ast.ImportFrom) else [])
            hits = banned.intersection(names)
            if hits:
                offenders.append(f"{path.name}:{node.lineno} {sorted(hits)}")
    assert offenders == []


def test_persistence_reads_no_clock():
    """Time is injected, so a restored record carries the instant it was written."""
    import ast

    offenders = []
    for path in _persistence_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in ("utcnow", "today"):
                offenders.append(f"{path.name}:{node.lineno}")
    assert offenders == []


def test_no_prompt_or_secret_is_persisted(store: GovernanceStore):
    """A governance database that accumulates prompts becomes the largest
    uncontrolled data store in the system."""
    snapshot, auth = _seed(store)
    BudgetService(store).reserve(
        authorization=auth, reservation_id="res1", idempotency_key="k1",
        amount=m("10"), reserve_component=m("0"),
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)

    tables = [r["name"] for r in store.connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")]
    banned = ("prompt", "raw_response", "api_key", "secret", "credential", "token_value")
    for table in tables:
        columns = [r["name"].lower() for r in
                   store.connection.execute(f"PRAGMA table_info({table})")]
        assert not any(b in c for c in columns for b in banned), table
        for row in store.connection.execute(f"SELECT * FROM {table}"):
            blob = " ".join(str(v).lower() for v in tuple(row))
            for word in ("sk-ant", "api_key", "authorization: bearer"):
                assert word not in blob, f"{table} carries {word!r}"


def test_the_database_path_is_injected_with_no_default(db_path: str):
    with pytest.raises(TypeError):
        GovernanceStore(clock=FixedClock(NOW))          # type: ignore[call-arg]


def test_the_orchestrator_is_still_untouched():
    import inspect

    from meta_orchestrator.orchestrator import orchestrator as orch_mod

    source = inspect.getsource(orch_mod)
    for name in ("planner.persistence", "GovernanceStore", "BudgetService",
                 "planner.governance"):
        assert name not in source


# =========================================================================== #
# Worked example — the whole persisted chain across a restart
# =========================================================================== #

def test_worked_example_reserve_restart_settle(db_path: str):
    store = GovernanceStore(db_path, clock=FixedClock(NOW))
    snapshot, auth = _seed(store, limit="100")

    reserved = BudgetService(store).reserve(
        authorization=auth, reservation_id="res1", idempotency_key="call-1",
        amount=m("10"), reserve_component=m("0"),
        expected_snapshot_hash=snapshot.content_hash(), at=NOW)
    assert reserved.status is SpendReservationStatus.COMMITTED
    assert store.budgets.current("b1").committed_spend == m("10")
    store.close()

    reopened = GovernanceStore(db_path, clock=FixedClock(NOW), create=False)
    try:
        current = reopened.budgets.current("b1")
        assert current.committed_spend == m("10")           # the hold survived
        assert current.snapshot_version == 2

        result = BudgetService(reopened).settle(
            reservation_id="res1", actual=m("6.5"),
            expected_snapshot_hash=current.content_hash(), at=NOW)
        assert result.review_required is False

        final = reopened.budgets.current("b1")
        assert final.actual_spend == m("6.5")
        assert final.committed_spend == Money.zero(USD)
        assert final.remaining == m("93.5")
        assert final.snapshot_version == 3
        assert [e.event_type for e in reopened.events.for_budget("b1")] == [
            GovernanceEventType.RESERVATION_COMMITTED,
            GovernanceEventType.RESERVATION_SETTLED]
    finally:
        reopened.close()


# =========================================================================== #
# Legacy designation
# =========================================================================== #

def test_the_old_guard_and_gate_paths_are_marked_legacy():
    """`planner/governance/` is canonical; these stay for compatibility only."""
    import meta_orchestrator.planner.approval as legacy_approval
    import meta_orchestrator.planner.budget as legacy_budget

    for module in (legacy_budget, legacy_approval):
        assert module.__doc__.startswith("LEGACY — do not use for new integrations")
        assert "planner.governance" in module.__doc__


def test_the_legacy_paths_have_no_persistence_of_their_own():
    """A second store would mean two answers to 'what is committed right now'."""
    import ast

    root = (Path(__file__).resolve().parents[1] / "src" / "meta_orchestrator"
            / "planner")
    offenders = []
    for package in ("budget", "approval"):
        for path in sorted((root / package).glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                         else [node.module or ""] if isinstance(node, ast.ImportFrom)
                         else [])
                if any("persistence" in n or "sqlite" in n for n in names):
                    offenders.append(f"{package}/{path.name}:{node.lineno}")
    assert offenders == []


def test_persistence_serves_the_governance_path_only():
    """Persistence knows about governance artifacts and nothing from the legacy layer."""
    import ast

    offenders = []
    for path in _persistence_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            module = node.module or ""
            # `..budget.errors` is the one shared exception type; the legacy guard and
            # gate implementations themselves are not imported.
            if module.endswith("approval") or module.endswith("approval.gate"):
                offenders.append(f"{path.name}:{node.lineno} {module}")
            if module.endswith("budget.guard") or module.endswith("budget.ledger"):
                offenders.append(f"{path.name}:{node.lineno} {module}")
    assert offenders == []
