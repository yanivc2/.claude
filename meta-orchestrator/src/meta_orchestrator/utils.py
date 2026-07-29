"""Small shared helpers."""
from __future__ import annotations

from datetime import datetime, timezone


def now_iso() -> str:
    """UTC timestamp in ISO-8601. Centralised so it is easy to inject/freeze in tests."""
    return datetime.now(timezone.utc).isoformat()


def today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()
