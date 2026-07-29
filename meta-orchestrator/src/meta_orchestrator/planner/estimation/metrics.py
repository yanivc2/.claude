"""Content metrics — what the estimator is actually given to measure.

A single characters-to-tokens multiplier is wrong, and the orchestrator's ``chars//4``
is the local instance of that mistake. The ratio differs by an order of magnitude
between English prose, Hebrew, source code and JSON, so the input has to carry enough
structure for a family-specific rule to apply.

Two size measures are kept apart on purpose:

* **UTF-8 bytes** — what crosses the wire. Hebrew costs two bytes per character,
  English one, so bytes alone overstate Hebrew relative to English.
* **Unicode code points** — what a reader would call "characters".

Neither is tokens. Both are inputs to a rule that produces tokens.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, model_validator


class ContentFamily(str, Enum):
    """What kind of content this is. Selects the token rule."""

    PROSE_LATIN = "prose_latin"          # English and other Latin-script prose
    PROSE_HEBREW = "prose_hebrew"        # Hebrew — token-dense, see rules.py
    PROSE_MIXED = "prose_mixed"          # more than one script in meaningful amounts
    SOURCE_CODE = "source_code"
    STRUCTURED_DATA = "structured_data"  # JSON, YAML, tables
    DIFF_PATCH = "diff_patch"
    TOOL_SCHEMA = "tool_schema"
    UNKNOWN = "unknown"                  # never silently guessed at


class ScriptHint(str, Enum):
    LATIN = "latin"
    HEBREW = "hebrew"
    MIXED = "mixed"
    UNKNOWN = "unknown"


class ContentMetrics(BaseModel):
    """Measured properties of one body of content. Facts, not estimates.

    The estimator never reads a file. Whatever collected these numbers did the reading;
    this type carries the result so estimation stays pure and testable.
    """

    model_config = ConfigDict(frozen=True)

    family: ContentFamily
    utf8_bytes: int = 0
    code_points: int = 0
    words: int = 0
    lines: int = 0
    files: int = 0
    script: ScriptHint = ScriptHint.UNKNOWN
    #: Portion of this content that is re-sent on every call (system prompt, shared
    #: context). Counted once per call, but it is not free and is not new information.
    repeated_context_code_points: int = 0

    @model_validator(mode="after")
    def _coherent(self) -> "ContentMetrics":
        for field in ("utf8_bytes", "code_points", "words", "lines", "files",
                      "repeated_context_code_points"):
            if getattr(self, field) < 0:
                raise ValueError(f"ContentMetrics.{field} cannot be negative")
        if self.utf8_bytes and self.code_points and self.utf8_bytes < self.code_points:
            raise ValueError(
                "utf8_bytes cannot be below code_points — every code point is at "
                "least one byte")
        if self.repeated_context_code_points > self.code_points:
            raise ValueError("repeated context cannot exceed the whole content")
        return self

    @property
    def is_empty(self) -> bool:
        return self.code_points == 0 and self.utf8_bytes == 0

    @property
    def novel_code_points(self) -> int:
        """Content excluding the part repeated on every call."""
        return max(0, self.code_points - self.repeated_context_code_points)

    @property
    def bytes_per_code_point(self) -> float | None:
        """Diagnostic only — a rough script signal. Never used to price anything."""
        if not self.code_points:
            return None
        return self.utf8_bytes / self.code_points


class RequestOverheads(BaseModel):
    """Fixed sizes that ride along on every call, independent of the task content."""

    model_config = ConfigDict(frozen=True)

    system_prompt_code_points: int = 0
    tool_schema_code_points: int = 0
    #: Content family for the overhead text, so it is not priced as if it were prose.
    family: ContentFamily = ContentFamily.PROSE_LATIN

    @model_validator(mode="after")
    def _non_negative(self) -> "RequestOverheads":
        for field in ("system_prompt_code_points", "tool_schema_code_points"):
            if getattr(self, field) < 0:
                raise ValueError(f"RequestOverheads.{field} cannot be negative")
        return self

    @property
    def total_code_points(self) -> int:
        return self.system_prompt_code_points + self.tool_schema_code_points
