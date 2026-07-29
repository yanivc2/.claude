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

import os
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


# --------------------------------------------------------------------------- #
# F2P test selection (see corpus/F2P_DETECTION_SPEC.md — FROZEN)
# --------------------------------------------------------------------------- #
_DEF_NAME = re.compile(r"^\s*def\s+([A-Za-z_]\w*)", re.MULTILINE)
F2P_PLAN_CAP = 8
_MIN_TOKEN_LEN = 3
# Fixture/data directories hold TEST INPUT, never runnable tests — even when the input is a
# `.py` file that happens to contain `def test...`. Running such a file collects/errors and
# masks the real F2P test as a harness gap. Files here are only ever fixtures (token source).
_DATA_DIR = re.compile(r"(^|/)(data|fixtures?)(/|$)")


def is_test_module(text: str) -> bool:
    """A pytest-collectable module: contains a test function or Test class."""
    return bool(re.search(r"\bdef test|\bclass Test", text))


def _is_data_path(path: str) -> bool:
    """True for paths under a data/fixtures directory — inputs, not runnable tests."""
    return bool(_DATA_DIR.search(path))


def plan_f2p_selection(
    fix_test_artifacts: list[str], tests_index: dict[str, str]
) -> tuple[list[tuple[str, str | None]], list[str]]:
    """Which tests to run to catch the F2P transition (frozen spec).

    Returns ``(plan, log)`` where plan is ``[(test_file, keyword|None), ...]``:
      * direct test modules the fix touched  → (file, None)  (run the whole file)
      * fixture artifacts → consuming test modules, run with ``-k <token>``
    ``tests_index`` maps every repo test ``.py`` path to its text (fixed tests overlaid).
    """
    log: list[str] = []
    plan: list[tuple[str, str | None]] = []
    seen: set[tuple[str, str | None]] = set()

    direct = [a for a in fix_test_artifacts
              if a.endswith(".py") and a in tests_index and is_test_module(tests_index[a])
              and not _is_data_path(a)]
    for a in direct:
        key = (a, None)
        if key not in seen:
            plan.append(key); seen.add(key); log.append(f"direct:{a}")

    fixtures = [a for a in fix_test_artifacts if a not in direct]
    token_consumers: list[tuple[str, list[str]]] = []
    for fx in fixtures:
        base = os.path.basename(fx)
        tokens = _DEF_NAME.findall(tests_index.get(fx, "")) if base == "conftest.py" \
            else [os.path.splitext(base)[0]]
        for token in tokens:
            if len(token) < _MIN_TOKEN_LEN:
                continue
            pat = re.compile(rf"\b{re.escape(token)}\b")
            consumers = sorted(t for t, txt in tests_index.items()
                               if is_test_module(txt) and not _is_data_path(t) and pat.search(txt))
            if consumers:
                token_consumers.append((token, consumers))

    for token, consumers in sorted(token_consumers, key=lambda kv: (-len(kv[1]), kv[0])):
        for f in consumers:
            key = (f, token)
            if key not in seen:
                plan.append(key); seen.add(key); log.append(f"fixture:{token}->{f}")

    if len(plan) > F2P_PLAN_CAP:
        log.append(f"capped {len(plan)}->{F2P_PLAN_CAP}")
        plan = plan[:F2P_PLAN_CAP]
    if not plan:
        log.append("no_relevant_test")
    return plan, log


# --------------------------------------------------------------------------- #
# Semantic sub-fingerprints (Axis C): the main `Logic` family is too coarse. Decompose
# the ADDED/REMOVED diff lines into objective semantic sub-categories. Multi-label (a fix
# may carry several); model-free. This is a DESCRIPTIVE overlay — it does NOT change the
# main fingerprint taxonomy or any gate.
# --------------------------------------------------------------------------- #
_SUBFP_PATTERNS: list[tuple[str, "re.Pattern[str]"]] = [
    ("condition_inversion", re.compile(r"\bnot \b|!=|==|\bis not\b|\bis None\b|\bTrue\b|\bFalse\b|\band \b|\bor \b")),
    ("boundary",            re.compile(r"[<>]=?|\blen\(|\brange\(|[-+]\s*1\b|\[[^\]]*[-+]\s*1\]")),
    ("whitespace",          re.compile(r"whitespace|indent|newline|blank|empty_line|\bspaces?\b|\\n|\\t")),
    ("parser_normalization", re.compile(r"\bparse|normaliz|\.strip\(|\.lstrip\(|\.rstrip\(|\.replace\(|\.split\(|token|lexer|ast\.")),
    ("ordering",            re.compile(r"\bsort(ed)?\(|\breverse|\.reverse\(|reorder")),
    ("iterator",            re.compile(r"\bfor \b|\bwhile \b|\byield\b|\bnext\(|enumerate\(|\[[^\]]* for ")),
    ("state_mutation",      re.compile(r"\.append\(|\.pop\(|\.add\(|\.update\(|\.extend\(|\bdel \b|\.insert\(")),
]


def _changed_text(patch_text: str) -> str:
    return "\n".join(ln[1:] for ln in patch_text.splitlines()
                     if ln[:1] in "+-" and ln[:3] not in ("+++", "---"))


def sub_fingerprints(patch_text: str) -> list[str]:
    """Objective, multi-label semantic sub-categories from the diff's changed lines.

    Only +/- lines are inspected (the actual change, not surrounding context). Returns the
    sorted set of matched labels; empty → falls back to ``["unclassified_logic"]``.
    """
    changed = _changed_text(patch_text)
    labels = [name for name, pat in _SUBFP_PATTERNS if pat.search(changed)]
    return sorted(labels) or ["unclassified_logic"]


# PRIMARY label: exactly ONE dominant semantic category per fix, to test whether the coarse
# `Logic` family actually merges distinct families (a measurement artifact) or is genuinely
# homogeneous. Specificity-ordered — the FIRST (rarest/most-distinctive) match wins, so
# generic signals (condition/boundary) only win when nothing more specific fired. Crucially,
# `condition_inversion` requires a REAL inversion token (not / != / is not), never a bare `==`.
# Descriptive heuristic (documented ordering), not a validated taxonomy; changes no gate.
_PRIMARY_ORDER: list[tuple[str, "re.Pattern[str]"]] = [
    ("whitespace",           re.compile(r"empty_line|EmptyLine|\bblank|\bnewline|whitespace|\\n|\bindent|\bdedent")),
    ("iterator",             re.compile(r"\bfor \b|\bwhile \b|\byield\b|\bnext\(|enumerate\(|\[[^\]]+ for ")),
    ("state_mutation",       re.compile(r"\.append\(|\.pop\(|\.add\(|\.update\(|\.extend\(|\.insert\(|\bdel \b")),
    ("parser_normalization", re.compile(r"\.strip\(|\.lstrip\(|\.rstrip\(|\.replace\(|\.split\(|normaliz|\bparse|token|lexer|ast\.")),
    ("boundary",             re.compile(r"[<>]=|(?<![<>!=])[<>](?!=)|\brange\(|\blen\(|[-+]\s*1\b")),
    ("condition_inversion",  re.compile(r"\bnot \b|!=|\bis not\b")),
]


def primary_sub_fingerprint(patch_text: str) -> str:
    """The single dominant semantic sub-category (specificity-ordered). Fallback: other_logic."""
    changed = _changed_text(patch_text)
    for name, pat in _PRIMARY_ORDER:
        if pat.search(changed):
            return name
    return "other_logic"


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
    # non-reproduction is 3-way — never claim "non-reproducible" until a harness gap is ruled out:
    #   likely_harness_gap | not_reproduced_under_current_harness | confirmed_non_reproducible
    nonrepro_class: str | None = None
    collected_any: bool = True            # did our overlay collect any target test node at all
    error_nodes_buggy: int = 0            # pytest ERROR (not FAIL) count on buggy = harness-gap signal
    f2p_selection: list[str] = Field(default_factory=list)  # which tests were chosen to run (audit)
    harness_intervention: str = ""        # documented BUG-SPECIFIC harness fix, if any (else none)
    # descriptive tier (NOT a gate) — objective, transparent heuristic
    high_learning_value: bool = False
    # decision (NO composite score — components only)
    admitted: bool = False
    reject_reason: str = ""


class PyBugHiveReport(BaseModel):
    slice_name: str
    total: int
    admitted: int
    rejected: int
    reproducible: int
    high_learning_value: int = 0
    harness_interventions: int = 0        # admitted tasks depending on a bug-specific harness fix
    candidates: list[CandidateMeta] = Field(default_factory=list)
    fingerprints_admitted: dict[str, int] = Field(default_factory=dict)
    fingerprints_rejected: dict[str, int] = Field(default_factory=dict)
    reject_reasons: dict[str, int] = Field(default_factory=dict)
    note: str = (
        "Objective metadata only (no model judgment). Components are kept, not a composite "
        "score. Rejection is degenerate-only, frozen before baseline. baseline_success & "
        "failure_reason are NOT here — they require solver runs (a separate, budgeted step)."
    )


# "high-learning-value" is a DESCRIPTIVE tier, never a gate — objective and transparent:
# an admitted fix with real substance to diagnose (multi-hunk and non-trivial line count).
HLV_MIN_HUNKS = 2
HLV_MIN_LINES = 10


def decide(meta: CandidateMeta) -> CandidateMeta:
    """Frozen gate: reproducible AND not degenerate → admitted. Non-reproduction keeps its
    3-way certainty class (never a bare "non-reproducible" claim). Also tags the descriptive
    high-learning-value tier (does NOT affect admission)."""
    if meta.reject_reason.startswith("error:"):   # unexpected harness crash — never mask as install
        meta.admitted = False
    elif not meta.installed:
        meta.admitted = False
        meta.reject_reason = "timeout_install" if meta.timed_out else "install_failed"
    elif meta.stable is False:
        meta.admitted, meta.reject_reason = False, "flaky"
    elif not meta.reproducible:
        meta.admitted = False
        meta.reject_reason = meta.nonrepro_class or "not_reproduced_under_current_harness"
    elif meta.degenerate:
        meta.admitted, meta.reject_reason = False, "degenerate_patch"
    else:
        meta.admitted, meta.reject_reason = True, ""
        if meta.patch and meta.patch.hunks >= HLV_MIN_HUNKS and meta.patch.changed_lines >= HLV_MIN_LINES:
            meta.high_learning_value = True
    return meta


# Frozen gate-decision thresholds (recorded before results are seen).
GATE2_MIN_ADMITTED = 6
GATE2_MIN_FINGERPRINTS = 3      # diversity guard — don't pass on ~6 near-identical bugs
GATE2_MAX_FP_SHARE = 0.70      # no single fingerprint may exceed 70% of admitted
GATE2_MAX_ENV_SHARE = 0.50     # env failures (install/flaky/timeout) must not dominate the slice


def recommend(report: "PyBugHiveReport") -> tuple[str, str]:
    """One of four verdicts + reasoning. NEVER selects for learnability; purely counts.

    ENVIRONMENT/DEPENDENCY FAILURE — installs/flaky/timeouts dominate and almost nothing
        reproduced: the environment, not the corpus, is the blocker (yield is uninformative).
    SUFFICIENT FOR GATE 2 — ALL of: ≥6 admitted; ≥3 distinct fingerprints; no single
        fingerprint >70% of admitted; NO admitted task depends on a bug-specific harness fix;
        the sample is stable (env failures ≤50% of candidates).
    QUANTITATIVELY SUFFICIENT, DIVERSITY INSUFFICIENT — ≥6 admitted but the fingerprints are
        too few / too concentrated.
    INSUFFICIENT YIELD — fewer than 6 admitted.
    """
    env_reasons = {"install_failed", "timeout_install", "flaky", "no_src_or_test_in_patch",
                   "likely_harness_gap"}
    env_blocked = sum(1 for m in report.candidates
                      if m.reject_reason in env_reasons or m.timed_out)
    env_share = env_blocked / report.total if report.total else 0.0
    if report.reproducible <= 1 and env_share >= GATE2_MAX_ENV_SHARE:
        return ("ENVIRONMENT/DEPENDENCY FAILURE",
                f"{env_blocked}/{report.total} candidates blocked on install/flaky/timeout/harness-gap "
                f"and only {report.reproducible} reproduced — the environment, not the corpus, limits it.")

    n_fp = len(report.fingerprints_admitted)
    top_share = (max(report.fingerprints_admitted.values()) / report.admitted
                 if report.admitted else 0.0)
    diverse = n_fp >= GATE2_MIN_FINGERPRINTS and top_share <= GATE2_MAX_FP_SHARE

    if report.admitted >= GATE2_MIN_ADMITTED:
        if not diverse:
            return ("QUANTITATIVELY SUFFICIENT, DIVERSITY INSUFFICIENT",
                    f"{report.admitted} admitted but only {n_fp} fingerprints "
                    f"(top share {top_share:.0%}) — needs ≥{GATE2_MIN_FINGERPRINTS} and no fp >70%.")
        if report.harness_interventions > 0:
            return ("INSUFFICIENT YIELD",
                    f"{report.admitted} admitted / {n_fp} fingerprints, but "
                    f"{report.harness_interventions} depend on bug-specific harness fixes — "
                    "not a clean corpus signal.")
        if env_share >= GATE2_MAX_ENV_SHARE:
            return ("INSUFFICIENT YIELD",
                    f"{report.admitted} admitted but env failures are {env_share:.0%} of the slice "
                    "(≥50%) — sample not stable enough to trust.")
        return ("SUFFICIENT FOR GATE 2",
                f"{report.admitted} admitted, {n_fp} fingerprints (top {top_share:.0%}), "
                f"0 harness-dependent, env failures {env_share:.0%} — all criteria met.")

    return ("INSUFFICIENT YIELD",
            f"{report.admitted} admitted / {n_fp} fingerprints — below the "
            f"{GATE2_MIN_ADMITTED}-admitted bar. Reproducibility works; the slice is just too thin.")


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
        high_learning_value=sum(1 for m in adm if m.high_learning_value),
        harness_interventions=sum(1 for m in adm if m.harness_intervention),
        candidates=metas,
        fingerprints_admitted=dict(Counter(m.fingerprint for m in adm if m.fingerprint)),
        fingerprints_rejected=dict(Counter(m.fingerprint for m in rej if m.fingerprint)),
        reject_reasons=dict(Counter(m.reject_reason for m in rej if m.reject_reason)),
    )
