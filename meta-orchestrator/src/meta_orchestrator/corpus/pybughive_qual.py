"""PyBugHive project-qualifier — objective, model-free metadata (v2-corpus §3/§4).

PyBugHive bugs are NOT single-file self-contained tasks (unlike the fixture pipeline):
each test imports the whole installed project, so qualification means clone → install →
run its suite. This module holds the *pure, deterministic* helpers (fingerprint, patch
metrics, degenerate-rejection, report aggregation) so they are unit-testable offline; the
clone/install/run I/O lives in ``examples/pybughive_qualify.py``.

Design constraints (frozen BEFORE any baseline is seen):
  * Only OBJECTIVE, free signals — no model judgment (no "complexity"/"reasoning"/"clarity").
  * Keep components, never a composite weighted score (invented weights = false precision).
  * Do NOT select tasks by apparent learnability (selection bias). Metadata DESCRIBES the
    corpus and REJECTS degenerate cases; it never fishes for "good" bugs.
  * Metadata is recorded for REJECTED candidates too — a corpus where every interesting
    bug fails to install and only trivial ones pass is biased, and only the rejected rows
    reveal it.
  * fingerprint = the EMPIRICAL task family (from the real F2P exception + patch shape),
    measured rather than assumed.
"""
from __future__ import annotations

import re
from collections import Counter

from pydantic import BaseModel, Field

# Empirical failure families (objective; primary signal = the real F2P exception type,
# secondary = what the patch touches). Order matters: first match wins.
FINGERPRINTS = [
    "ImportError", "Packaging", "Path", "Attribute", "API misuse",
    "Parser", "Async", "Typing", "Logic",
]

_EXC = re.compile(r"\b([A-Z][A-Za-z]*(?:Error|Exception|Warning))\b")
_EXC_TO_FAMILY = {
    "ImportError": "ImportError", "ModuleNotFoundError": "ImportError",
    "AttributeError": "Attribute",
    "TypeError": "Typing", "ValueError": "Logic", "KeyError": "Logic",
    "IndexError": "Logic", "AssertionError": "Logic",
    "FileNotFoundError": "Path", "IsADirectoryError": "Path", "NotADirectoryError": "Path",
    "UnicodeDecodeError": "Parser", "UnicodeEncodeError": "Parser", "SyntaxError": "Parser",
}
_PACKAGING_FILES = re.compile(r"(setup\.py|setup\.cfg|pyproject\.toml|requirements[^/]*\.txt|Pipfile)")
_PATH_HINT = re.compile(r"\b(os\.path|pathlib|Path\(|abspath|dirname|join\()")
_ASYNC_HINT = re.compile(r"\b(async def|await |asyncio|aiohttp)\b")
_TYPING_HINT = re.compile(r"(->\s*[A-Za-z]|: *[A-Z][A-Za-z]*\[|typing\.|Optional\[|List\[|Dict\[)")
_PARSER_HINT = re.compile(r"\b(parse|tokeniz|lexer|json\.loads|yaml\.|ast\.)")
_IMPORT_HINT = re.compile(r"^[+-]\s*(import |from \w+ import )", re.MULTILINE)


def fingerprint(f2p_error: str, patch_text: str, changed_files: list[str]) -> str:
    """Empirical failure family. Primary: the real F2P exception; secondary: patch shape.

    Deterministic and free — no model call. Returns one of ``FINGERPRINTS``.
    """
    # 1. Primary — the actual exception the F2P test raised on the buggy code.
    for exc in _EXC.findall(f2p_error or ""):
        if exc in _EXC_TO_FAMILY:
            return _EXC_TO_FAMILY[exc]
    # 2. Secondary — what the fix touches (objective, from the diff / filenames).
    if any(_PACKAGING_FILES.search(f) for f in changed_files):
        return "Packaging"
    if _IMPORT_HINT.search(patch_text):
        return "ImportError"
    if _ASYNC_HINT.search(patch_text):
        return "Async"
    if _PATH_HINT.search(patch_text):
        return "Path"
    if _PARSER_HINT.search(patch_text):
        return "Parser"
    if _TYPING_HINT.search(patch_text):
        return "Typing"
    return "Logic"


class PatchMetrics(BaseModel):
    files: int
    added: int
    deleted: int
    hunks: int
    locality: str  # "single-file" | "multi-file"

    @property
    def changed_lines(self) -> int:
        return self.added + self.deleted


def patch_metrics(src_files: list[dict]) -> PatchMetrics:
    """Objective diff metrics from PyBugHive commit ``stat.files`` entries (non-test src)."""
    added = sum(f.get("additions", 0) for f in src_files)
    deleted = sum(f.get("deletions", 0) for f in src_files)
    hunks = sum(len(re.findall(r"^@@ ", f.get("patch", ""), re.MULTILINE)) for f in src_files)
    n = len(src_files)
    return PatchMetrics(
        files=n, added=added, deleted=deleted, hunks=hunks,
        locality="single-file" if n <= 1 else "multi-file",
    )


# Frozen degenerate-rejection rule (recorded BEFORE any baseline is seen). A "degenerate"
# fix is one with nothing to diagnose — a one-line/typo change. This REJECTS noise; it does
# NOT select for learnability (we don't keep "hard" bugs, we only drop trivial ones).
DEGENERATE_MAX_LINES = 2
DEGENERATE_MAX_HUNKS = 1


def is_degenerate(m: PatchMetrics) -> bool:
    """True when the fix is too small to require any diagnosis (single hunk, ≤2 lines)."""
    return m.hunks <= DEGENERATE_MAX_HUNKS and m.changed_lines <= DEGENERATE_MAX_LINES


class CandidateMeta(BaseModel):
    """Per-candidate objective metadata — populated for admitted AND rejected alike."""

    candidate_id: str
    project: str
    issue: int
    # reproducibility (the free gate)
    installed: bool = False
    f2p_fail_on_buggy: bool | None = None
    f2p_pass_on_fixed: bool | None = None
    p2p_clean_on_buggy: bool | None = None
    stable: bool | None = None            # same verdict on 2 runs of the same revision
    reproducible: bool = False            # F2P fail→pass AND stable
    # objective descriptors
    patch: PatchMetrics | None = None
    fingerprint: str | None = None
    degenerate: bool | None = None
    runtime_s: float = 0.0
    install_s: float = 0.0
    test_s: float = 0.0
    timed_out: bool = False
    n_test_runs: int = 0                  # how many pytest invocations ran (reruns incl.)
    # decision (NO composite score — components only)
    admitted: bool = False
    reject_reason: str = ""


class PyBugHiveReport(BaseModel):
    slice_name: str
    total: int
    admitted: int
    rejected: int
    reproducible: int
    candidates: list[CandidateMeta] = Field(default_factory=list)
    fingerprints_admitted: dict[str, int] = Field(default_factory=dict)
    fingerprints_rejected: dict[str, int] = Field(default_factory=dict)
    note: str = (
        "Objective metadata only (no model judgment). Components are kept, not a composite "
        "score. Rejection is degenerate-only, frozen before baseline. baseline_success & "
        "failure_reason are NOT here — they require solver runs (a separate, budgeted step)."
    )


def decide(meta: CandidateMeta) -> CandidateMeta:
    """Apply the frozen gate: reproducible AND not degenerate → admitted. Records the reason."""
    if not meta.installed:
        meta.admitted, meta.reject_reason = False, "install_failed"
    elif meta.stable is False:
        meta.admitted, meta.reject_reason = False, "flaky"
    elif not meta.reproducible:
        meta.admitted, meta.reject_reason = False, "not_reproducible"
    elif meta.degenerate:
        meta.admitted, meta.reject_reason = False, "degenerate_patch"
    else:
        meta.admitted, meta.reject_reason = True, ""
    return meta


# Frozen gate-decision thresholds (recorded before results are seen).
GATE2_MIN_ADMITTED = 6
GATE2_MIN_FINGERPRINTS = 3   # diversity guard — don't pass on ~6 near-identical bugs


def recommend(report: "PyBugHiveReport") -> tuple[str, str]:
    """One of three verdicts + reasoning. NEVER selects for learnability; purely counts.

    ENVIRONMENT/DEPENDENCY FAILURE — the slice couldn't be exercised (installs/timeouts
        dominate and almost nothing reproduced): the environment is the blocker, not the
        corpus, so yield is uninformative.
    SUFFICIENT FOR GATE 2 — ≥ GATE2_MIN_ADMITTED admitted AND ≥ GATE2_MIN_FINGERPRINTS
        distinct fingerprints among them (enough, and diverse enough, for §2).
    INSUFFICIENT YIELD — reproduced fine but too few / too homogeneous admitted tasks.
    """
    env_reasons = {"install_failed", "flaky", "no_src_or_test_in_patch"}
    env_blocked = sum(1 for m in report.candidates if m.reject_reason in env_reasons or m.timed_out)
    if report.total and report.reproducible <= 1 and env_blocked >= max(1, report.total // 2):
        return ("ENVIRONMENT/DEPENDENCY FAILURE",
                f"{env_blocked}/{report.total} candidates blocked on install/flaky/timeout and only "
                f"{report.reproducible} reproduced — the environment, not the corpus, is the limiter.")
    n_fp = len(report.fingerprints_admitted)
    if report.admitted >= GATE2_MIN_ADMITTED and n_fp >= GATE2_MIN_FINGERPRINTS:
        return ("SUFFICIENT FOR GATE 2",
                f"{report.admitted} admitted across {n_fp} distinct fingerprints "
                f"(≥{GATE2_MIN_ADMITTED} and ≥{GATE2_MIN_FINGERPRINTS}).")
    return ("INSUFFICIENT YIELD",
            f"{report.admitted} admitted / {n_fp} fingerprints — below the "
            f"{GATE2_MIN_ADMITTED}-admitted, {GATE2_MIN_FINGERPRINTS}-fingerprint bar. "
            "Reproducibility is fine; the bounded slice simply doesn't yield enough diverse tasks.")


def build_report(slice_name: str, metas: list[CandidateMeta]) -> PyBugHiveReport:
    """Aggregate — including separate fingerprint distributions for admitted vs rejected."""
    metas = [decide(m) for m in metas]
    adm = [m for m in metas if m.admitted]
    rej = [m for m in metas if not m.admitted]
    return PyBugHiveReport(
        slice_name=slice_name,
        total=len(metas),
        admitted=len(adm),
        rejected=len(rej),
        reproducible=sum(1 for m in metas if m.reproducible),
        candidates=metas,
        fingerprints_admitted=dict(Counter(m.fingerprint for m in adm if m.fingerprint)),
        fingerprints_rejected=dict(Counter(m.fingerprint for m in rej if m.fingerprint)),
    )
