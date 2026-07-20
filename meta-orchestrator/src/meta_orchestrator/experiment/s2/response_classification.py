"""Fail-closed classification of a model response (Decision A, part A).

The black-112 canary hit ``output_tokens == max_tokens`` (``stop_reason == "max_tokens"``): the reply
was TRUNCATED, yet the parser extracted a usable patch and the run recorded a silent "pass" with an
empty lesson. This module makes that impossible: a truncated reply is classified ``TRUNCATED_OUTPUT``
and the runner treats it as a TERMINAL ``SOLVER_FAIL_TRUNCATED`` — no official pass, no write-gate, no
bank mutation, no automatic Round 2, no automatic retry.

Two independent truncation signals (either one trips it): the authoritative ``stop_reason`` and the
structural absence of the mandatory ``### END`` sentinel. ``INFRA_FAILURE`` is decided at the transport
layer (an exception before/after send), not here.
"""
from __future__ import annotations

from typing import Optional

TRUNCATED_OUTPUT = "TRUNCATED_OUTPUT"
MALFORMED_OUTPUT = "MALFORMED_OUTPUT"
VALID_COMPLETE_OUTPUT = "VALID_COMPLETE_OUTPUT"
REFUSAL = "REFUSAL"
INFRA_FAILURE = "INFRA_FAILURE"

# the terminal solver-outcome label the runner records for a truncated reply
SOLVER_FAIL_TRUNCATED = "SOLVER_FAIL_TRUNCATED"


def classify_response(*, stop_reason: Optional[str], end_marker_present: bool, parse_ok: bool
                      ) -> str:
    """Classify a *received* reply (transport already succeeded). Fail-closed on truncation.

    Priority: truncation (max_tokens OR missing ``### END``) wins over everything, so a patch that
    happens to parse out of a truncated body can never be counted. Then refusal, then malformed, then
    a complete valid response.
    """
    if stop_reason == "max_tokens" or not end_marker_present:
        return TRUNCATED_OUTPUT
    if stop_reason == "refusal":
        return REFUSAL
    if not parse_ok:
        return MALFORMED_OUTPUT
    return VALID_COMPLETE_OUTPUT


def is_official_pass_eligible(classification: str) -> bool:
    """Only a complete, well-formed reply may be applied, graded as an official pass, and (in C-train)
    reach the write-gate. Everything else is a recorded solver failure."""
    return classification == VALID_COMPLETE_OUTPUT
