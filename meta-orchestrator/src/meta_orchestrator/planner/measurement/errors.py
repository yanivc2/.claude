"""Fail-closed errors for the token pilot (P2m).

Every one of these stops the pilot rather than letting it improvise. The pilot would
rather produce no measurement than a fabricated one — a made-up token count is worse
than a missing column, because someone might calibrate against it.
"""
from __future__ import annotations


class MeasurementError(Exception):
    """Base for token-pilot errors."""


class CredentialUnavailableError(MeasurementError):
    """No API credential is resolvable, so no real measurement can be taken.

    Raised instead of guessing. P2m §9: do not try alternative keys, do not alter
    credentials — stop and report. The pilot marks the measured column BLOCKED.
    """


class PilotBudgetExhaustedError(MeasurementError):
    """The hard budget cap or call ceiling would be exceeded. Nothing is sent."""


class UnsupportedModelError(MeasurementError):
    """A model other than the single authorised pilot model was requested."""


class GenerationForbiddenError(MeasurementError):
    """Something tried to request output. P2m measures input tokens only."""


class ZeroTokenMeasurementError(MeasurementError):
    """A measured count of zero for non-empty input is not trusted — fail closed."""
