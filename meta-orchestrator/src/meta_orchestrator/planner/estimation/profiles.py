"""Rule profiles — the coefficients, and an honest label for where each came from.

Every number here is a **heuristic**. None was fitted to observed data, because no
observed data exists yet: nothing in this repository has ever compared an estimated
token count against an actual one. `RuleBasis` exists so that fact travels with the
coefficient instead of being lost the moment the number looks plausible.

The §2 closeout is the reason for the label. Its headline result was
apparatus-dominated and its confidence turned out to rest on n=8; the lesson carried
forward is not "avoid estimates" but "never let an estimate claim a provenance it does
not have". A profile marked ``HEURISTIC`` may be used freely — it just may not be
described as calibrated.

Ratios are **code points per token**. A lower number means the content is more
token-dense.
"""
from __future__ import annotations

from decimal import Decimal
from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .metrics import ContentFamily

#: Bump whenever any coefficient changes. Estimates record it, so a historical
#: estimate stays reproducible after the ruleset moves on.
RULESET_VERSION = "rules-v1"
ESTIMATOR_ID = "rules-based-usage-estimator"
ESTIMATOR_VERSION = "1.0.0"


class RuleBasis(str, Enum):
    """Where a coefficient came from. Only ``HEURISTIC`` is permitted in P1b."""

    #: Reasoned from general knowledge of tokenizer behaviour. Not measured here.
    HEURISTIC = "heuristic"
    #: Averaged over recorded runs in this repository.
    HISTORICAL_AVERAGE = "historical_average"
    #: Fitted and checked against held-out actuals.
    CALIBRATED = "calibrated"
    #: Produced by a learned model.
    LEARNED = "learned"


#: What P1b is allowed to ship. Anything else would be a claim without evidence.
ALLOWED_BASES_P1B: frozenset[RuleBasis] = frozenset({RuleBasis.HEURISTIC})


class TokenRule(BaseModel):
    """Code-points-per-token for one content family, with its rationale and spread.

    Three ratios rather than one: the same text tokenizes differently depending on
    vocabulary, and a single figure would hide that. ``dense`` produces *more* tokens
    (the worst case for cost), ``sparse`` fewer.
    """

    model_config = ConfigDict(frozen=True)

    family: ContentFamily
    basis: RuleBasis
    #: Fewest tokens — most code points per token.
    sparse_cp_per_token: str
    expected_cp_per_token: str
    #: Most tokens — fewest code points per token.
    dense_cp_per_token: str
    rationale: str
    limitations: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _ordered_and_labelled(self) -> "TokenRule":
        sparse = Decimal(self.sparse_cp_per_token)
        expected = Decimal(self.expected_cp_per_token)
        dense = Decimal(self.dense_cp_per_token)
        if not (dense <= expected <= sparse):
            raise ValueError(
                f"{self.family.value}: need dense <= expected <= sparse "
                f"(more tokens .. fewer tokens), got {dense}/{expected}/{sparse}")
        if dense <= 0:
            raise ValueError("a code-points-per-token ratio must be positive")
        if not self.rationale.strip():
            raise ValueError(f"{self.family.value}: a rule must say where it came from")
        if self.basis not in ALLOWED_BASES_P1B:
            raise ValueError(
                f"{self.family.value}: basis {self.basis.value} is not permitted in "
                "P1b — only HEURISTIC, until actuals exist")
        return self

    def tokens_for(self, code_points: int, *, worst: bool = False,
                   best: bool = False) -> int:
        """Convert code points to tokens. Rounds up: a partial token is still billed."""
        if code_points <= 0:
            return 0
        ratio = (Decimal(self.dense_cp_per_token) if worst
                 else Decimal(self.sparse_cp_per_token) if best
                 else Decimal(self.expected_cp_per_token))
        tokens = Decimal(code_points) / ratio
        return int(tokens.to_integral_value(rounding="ROUND_CEILING"))


_LATIN = TokenRule(
    family=ContentFamily.PROSE_LATIN,
    basis=RuleBasis.HEURISTIC,
    sparse_cp_per_token="4.5", expected_cp_per_token="4.0", dense_cp_per_token="3.2",
    rationale=("English prose sits near four characters per token on byte-pair "
               "vocabularies, which are trained predominantly on English text"),
    limitations=["not measured against this system's own traffic",
                 "other Latin-script languages are token-denser than English"],
)

_HEBREW = TokenRule(
    family=ContentFamily.PROSE_HEBREW,
    basis=RuleBasis.HEURISTIC,
    sparse_cp_per_token="2.2", expected_cp_per_token="1.7", dense_cp_per_token="1.1",
    rationale=("Hebrew is markedly token-denser than English: it is a smaller share of "
               "tokenizer training data, so words fragment into more pieces, and each "
               "character is two UTF-8 bytes. Treating it at the Latin ratio would "
               "understate a Hebrew prompt roughly two-fold — the failure mode this "
               "whole module exists to prevent"),
    limitations=["not measured; the true ratio varies with niqqud and loanwords",
                 "the dense bound approaches one token per character for rare words"],
)

_MIXED = TokenRule(
    family=ContentFamily.PROSE_MIXED,
    basis=RuleBasis.HEURISTIC,
    sparse_cp_per_token="3.0", expected_cp_per_token="2.2", dense_cp_per_token="1.3",
    rationale=("mixed-script text is bounded below by its densest component; this sits "
               "between the Latin and Hebrew rules and leans toward the denser side, "
               "because script switches themselves tend to break tokens"),
    limitations=["the true value depends on the unmeasured mixing proportion",
                 "prefer classifying the parts separately when the split is known"],
)

_CODE = TokenRule(
    family=ContentFamily.SOURCE_CODE,
    basis=RuleBasis.HEURISTIC,
    sparse_cp_per_token="4.0", expected_cp_per_token="3.3", dense_cp_per_token="2.4",
    rationale=("source code is denser than prose: punctuation, indentation and "
               "identifier fragments each tend to become their own token"),
    limitations=["varies widely by language; minified or dense code approaches the "
                 "dense bound", "long repeated identifiers tokenize better than this"],
)

_STRUCTURED = TokenRule(
    family=ContentFamily.STRUCTURED_DATA,
    basis=RuleBasis.HEURISTIC,
    sparse_cp_per_token="3.5", expected_cp_per_token="2.8", dense_cp_per_token="2.0",
    rationale=("JSON and YAML carry heavy punctuation and repeated keys; the "
               "structural characters dominate the token count in small records"),
    limitations=["large repeated schemas tokenize better than small varied records"],
)

_DIFF = TokenRule(
    family=ContentFamily.DIFF_PATCH,
    basis=RuleBasis.HEURISTIC,
    sparse_cp_per_token="3.8", expected_cp_per_token="3.0", dense_cp_per_token="2.2",
    rationale=("a patch is code plus per-line markers and hunk headers, so it is "
               "slightly denser than the code it describes"),
    limitations=["context lines shift this toward the plain-code ratio"],
)

_TOOL_SCHEMA = TokenRule(
    family=ContentFamily.TOOL_SCHEMA,
    basis=RuleBasis.HEURISTIC,
    sparse_cp_per_token="3.2", expected_cp_per_token="2.6", dense_cp_per_token="1.9",
    rationale=("tool schemas are JSON with long descriptive strings and deep nesting — "
               "denser than ordinary structured data"),
    limitations=["not measured against real tool definitions in this repository"],
)

_UNKNOWN = TokenRule(
    family=ContentFamily.UNKNOWN,
    basis=RuleBasis.HEURISTIC,
    sparse_cp_per_token="3.0", expected_cp_per_token="2.0", dense_cp_per_token="1.0",
    rationale=("content of unknown kind is bounded by the worst plausible case — one "
               "token per character — because guessing a friendlier ratio for text "
               "nobody classified is how an estimate silently understates"),
    limitations=["deliberately pessimistic; classify the content to do better",
                 "an estimate resting on this rule is reported as incomplete"],
)

TOKEN_RULES: dict[ContentFamily, TokenRule] = {
    r.family: r for r in
    (_LATIN, _HEBREW, _MIXED, _CODE, _STRUCTURED, _DIFF, _TOOL_SCHEMA, _UNKNOWN)
}


class OutputProfile(BaseModel):
    """How much the model is expected to *write*, independent of what it reads.

    Output is deliberately not a function of input size. A one-line question about a
    large repository produces a short answer; a short instruction to write a document
    produces a long one. Deriving output from input is a category error the seed-task
    estimator makes today.
    """

    model_config = ConfigDict(frozen=True)

    profile_id: str
    basis: RuleBasis = RuleBasis.HEURISTIC
    best_output_tokens: int
    expected_output_tokens: int
    worst_output_tokens: int
    rationale: str
    limitations: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _ordered(self) -> "OutputProfile":
        if not (self.best_output_tokens <= self.expected_output_tokens
                <= self.worst_output_tokens):
            raise ValueError(f"{self.profile_id}: need best <= expected <= worst")
        if self.best_output_tokens < 0:
            raise ValueError("output tokens cannot be negative")
        if self.basis not in ALLOWED_BASES_P1B:
            raise ValueError(f"{self.profile_id}: only HEURISTIC bases in P1b")
        if not self.rationale.strip():
            raise ValueError(f"{self.profile_id}: an output profile needs a rationale")
        return self

    def capped(self, cap: Optional[int]) -> "OutputProfile":
        """Clamp every bound to an explicit per-call output cap.

        With a cap in force, the worst case cannot exceed it — that is what a cap
        means. Without one, ``worst`` stays the profile's own bound and the estimate
        is marked incomplete elsewhere.
        """
        if cap is None:
            return self
        if cap < 0:
            raise ValueError("an output cap cannot be negative")
        return self.model_copy(update={
            "best_output_tokens": min(self.best_output_tokens, cap),
            "expected_output_tokens": min(self.expected_output_tokens, cap),
            "worst_output_tokens": min(self.worst_output_tokens, cap),
        })


def output_profile(profile_id: str, *, best: int, expected: int, worst: int,
                   rationale: str, limitations: Optional[list[str]] = None
                   ) -> OutputProfile:
    return OutputProfile(profile_id=profile_id, best_output_tokens=best,
                         expected_output_tokens=expected, worst_output_tokens=worst,
                         rationale=rationale, limitations=limitations or [])
