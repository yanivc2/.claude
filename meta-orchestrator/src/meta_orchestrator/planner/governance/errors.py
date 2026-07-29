"""Governance errors. Each one stops a decision before it becomes an action."""
from __future__ import annotations

from ..contracts.errors import PlannerError


class GovernanceError(PlannerError):
    """Base for governance failures."""


class BlockedByConditionError(GovernanceError):
    """One or more blocking conditions stand. They cannot be acknowledged away."""

    def __init__(self, codes: list[str], detail: str = "") -> None:
        self.codes = codes
        suffix = f" — {detail}" if detail else ""
        super().__init__(f"blocked by: {', '.join(codes)}{suffix}")


class MissingAcknowledgementError(GovernanceError):
    """An acknowledgeable risk was raised and nobody signed off on it."""

    def __init__(self, codes: list[str]) -> None:
        self.codes = codes
        super().__init__(
            f"these risks require an explicit acknowledgement: {', '.join(codes)}")


class StaleSnapshotError(GovernanceError):
    """The budget moved between admission and authorization.

    Logical protection only. It catches a snapshot that has been superseded; it does
    not serialise concurrent writers, which needs a transaction this system does not
    yet have.
    """

    def __init__(self, approved_hash: str, current_hash: str) -> None:
        self.approved_hash, self.current_hash = approved_hash, current_hash
        super().__init__(
            f"budget snapshot has moved since approval "
            f"({approved_hash[:16]}… -> {current_hash[:16]}…) — re-admit and re-approve")


class BindingMismatchError(GovernanceError):
    """An artifact no longer matches something the approval was granted against."""

    def __init__(self, field: str, approved: str, current: str) -> None:
        self.field, self.approved, self.current = field, approved, current
        super().__init__(
            f"{field} changed since approval ({approved[:16]}… -> {current[:16]}…) — "
            "the approval no longer covers this run")


class PurposeMismatchError(GovernanceError):
    """A simulation decision was offered as authority for real spend."""


class ReserveModeNotPermittedError(GovernanceError):
    """This reserve basis is not allowed for this purpose."""

    def __init__(self, basis: str, purpose: str) -> None:
        self.basis, self.purpose = basis, purpose
        super().__init__(f"reserve basis {basis} is not permitted under {purpose}")


class PriceTooOldError(GovernanceError):
    """The price is older than the policy allows, and there is no fallback."""

    def __init__(self, model_id: str, verified_at: str, max_age_days: int) -> None:
        self.model_id, self.verified_at = model_id, verified_at
        super().__init__(
            f"price for {model_id!r} was verified {verified_at} which exceeds the "
            f"{max_age_days}-day freshness policy — no stale-price fallback exists")


class IdempotencyConflictError(GovernanceError):
    """The same idempotency key was reused with different content.

    Retrying with an identical payload is safe and returns the original result.
    Reusing the key for something else is a bug that would otherwise silently spend
    twice or silently spend the wrong amount.
    """

    def __init__(self, key: str) -> None:
        self.key = key
        super().__init__(
            f"idempotency key {key!r} was already used with a different payload")


class InvalidReservationTransitionError(GovernanceError):
    """A reservation was moved between states in a way the lifecycle forbids."""

    def __init__(self, reservation_id: str, src: str, dst: str) -> None:
        self.reservation_id, self.src, self.dst = reservation_id, src, dst
        super().__init__(
            f"reservation {reservation_id!r}: {src} -> {dst} is not a legal transition")


class OverrunError(GovernanceError):
    """Settlement came in above what was reserved. Never widens the cap silently."""

    def __init__(self, reservation_id: str, reserved: str, actual: str) -> None:
        self.reservation_id = reservation_id
        super().__init__(
            f"reservation {reservation_id!r} settled at {actual} against {reserved} "
            "reserved — recorded as an overrun requiring review, not absorbed")
