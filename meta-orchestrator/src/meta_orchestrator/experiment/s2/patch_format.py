"""Frozen SEARCH/REPLACE patch format (Decision A) — the ONE minimal-edit transport for the paid
§2 attempt, replacing the full-file-return schema.

The full-file schema made output scale with the *file* size (blib2to3/tokenize.py ≈ 6-7k tokens),
so at ``max_tokens`` the trailing ``### LESSON`` was truncated (the black-112 canary defect). Here
output scales with the *fix* size, and truncation is caught structurally (a mandatory ``### END``
sentinel) and by ``stop_reason`` — never silently accepted.

Content-addressed and deterministic (Decision A): a SEARCH block is matched as an EXACT substring of
the pre-image, must match EXACTLY once, spans must not overlap. No fuzzy matching, no whitespace
normalisation, no repair, no whole-file fallback — any of those would re-introduce the "did the model
emit a byte-perfect diff" confound or silently "fix" a wrong edit.

Two layers, split by whether the pre-image (source) is available:

  * ``parse_patch_region`` — STRUCTURAL (text only): splits ``### FILE:`` / SEARCH-REPLACE blocks,
    enforces the frozen caps + schema, rejects an empty SEARCH, a sentinel collision, or an
    out-of-scope path. It never sees the source, so it also runs in the count-tokens / dry paths.
  * ``apply_search_replace`` — SEMANTIC (needs the pre-image): exact-match each SEARCH exactly once,
    require non-overlapping spans, apply high→low offset. 0 / >1 / overlap → deterministic reject.

The caps come from the corpus worst case (measured offline over the 27 reference fixes) PLUS a
methodological margin — never from the budget. ``max_tokens`` is calibrated to fit these caps, not
the reverse.
"""
from __future__ import annotations

from typing import NamedTuple, Optional

# --- frozen schema sentinels (a line must equal the marker EXACTLY to be structural) ---
LESSON_MARK = "### LESSON"
PATCH_MARK = "### PATCH"
FILE_MARK = "### FILE:"                 # followed by exactly one allowed path
END_MARK = "### END"
SR_SEARCH = "<<<<<<< SEARCH"
SR_DIVIDE = "======="
SR_REPLACE = ">>>>>>> REPLACE"
_SENTINEL_LINES = frozenset({LESSON_MARK, PATCH_MARK, END_MARK, SR_SEARCH, SR_DIVIDE, SR_REPLACE})

# --- frozen caps (corpus worst over 27 reference fixes: 9769 total chars / 24 blocks / 1599 search /
#     2306 replace / 5 files) + a ~2× methodological margin. NOT derived from the budget. ---
MAX_FILES_TOUCHED = 5                   # corpus max touched files (also bounded by allowed_source_files)
MAX_PATCH_BLOCKS = 40                   # measured 24
MAX_BLOCK_SEARCH_CHARS = 3200          # measured 1599
MAX_BLOCK_REPLACE_CHARS = 4608         # measured 2306
MAX_TOTAL_PATCH_CHARS = 20000          # measured 9769 (search+replace summed)
MAX_LESSON_CHARS = 1500

# taxonomy codes (schema-side raised here; apply-side raised by apply_search_replace)
SCHEMA_INVALID = "PATCH_SCHEMA_INVALID"
PATH_FORBIDDEN = "PATCH_PATH_FORBIDDEN"
LIMIT_EXCEEDED = "PATCH_LIMIT_EXCEEDED"
SEARCH_NOT_FOUND = "PATCH_SEARCH_NOT_FOUND"
SEARCH_AMBIGUOUS = "PATCH_SEARCH_AMBIGUOUS"
OVERLAP = "PATCH_OVERLAP"


class PatchFormatError(ValueError):
    """A structural or apply failure carrying a frozen taxonomy ``code`` (+ optional detail)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}:{detail}" if detail else code)
        self.code = code
        self.detail = detail


class SearchReplace(NamedTuple):
    search: str
    replace: str


def caps_snapshot() -> dict:
    """The frozen caps, for the request-template hash + Gate-1 artifact (tamper-evident)."""
    return {"max_files_touched": MAX_FILES_TOUCHED, "max_patch_blocks": MAX_PATCH_BLOCKS,
            "max_block_search_chars": MAX_BLOCK_SEARCH_CHARS,
            "max_block_replace_chars": MAX_BLOCK_REPLACE_CHARS,
            "max_total_patch_chars": MAX_TOTAL_PATCH_CHARS, "max_lesson_chars": MAX_LESSON_CHARS}


def _has_sentinel_line(body: str) -> bool:
    for ln in body.split("\n"):
        s = ln.strip()
        if s in _SENTINEL_LINES or s.startswith(FILE_MARK):
            return True
    return False


def parse_patch_region(region: str, allowed_source_files: list[str]
                       ) -> "list[tuple[str, list[SearchReplace]]]":
    """Structurally parse the text BETWEEN ``### PATCH`` and ``### END`` into ordered per-file edits.

    Returns ``[(path, [SearchReplace, ...]), ...]`` preserving file order. Raises ``PatchFormatError``
    with a taxonomy code on any schema/caps/path violation. Does NOT touch the source — match/overlap
    are the applier's job.
    """
    allowed = set(allowed_source_files)
    lines = region.split("\n")
    n = len(lines)
    i = 0
    per_file: "dict[str, list[SearchReplace]]" = {}
    order: list[str] = []
    current: Optional[str] = None
    total_blocks = 0
    total_chars = 0

    def _line(idx: int) -> str:
        return lines[idx]

    while i < n:
        raw = lines[i]
        stripped = raw.strip()
        if stripped == "":
            i += 1
            continue
        if raw.startswith(FILE_MARK):
            path = raw[len(FILE_MARK):].strip()
            if not path:
                raise PatchFormatError(SCHEMA_INVALID, "empty_file_path")
            if path not in allowed:
                raise PatchFormatError(PATH_FORBIDDEN, path)
            if path not in per_file:
                per_file[path] = []
                order.append(path)
            current = path
            i += 1
            continue
        if raw == SR_SEARCH:
            if current is None:
                raise PatchFormatError(SCHEMA_INVALID, "block_before_file")
            # search body: lines until the FIRST divider line
            i += 1
            s_start = i
            while i < n and lines[i] != SR_DIVIDE:
                if lines[i] == SR_REPLACE or lines[i] == SR_SEARCH:
                    raise PatchFormatError(SCHEMA_INVALID, "missing_divider")
                i += 1
            if i >= n:
                raise PatchFormatError(SCHEMA_INVALID, "unterminated_search")
            search = "\n".join(lines[s_start:i])
            i += 1                                     # consume the divider
            # replace body: lines until the FIRST replace-end line
            r_start = i
            while i < n and lines[i] != SR_REPLACE:
                if lines[i] == SR_DIVIDE or lines[i] == SR_SEARCH:
                    raise PatchFormatError(SCHEMA_INVALID, "missing_replace_end")
                i += 1
            if i >= n:
                raise PatchFormatError(SCHEMA_INVALID, "unterminated_replace")
            replace = "\n".join(lines[r_start:i])
            i += 1                                     # consume the replace-end
            if search == "":
                raise PatchFormatError(SCHEMA_INVALID, "empty_search")
            if _has_sentinel_line(search) or _has_sentinel_line(replace):
                raise PatchFormatError(SCHEMA_INVALID, "sentinel_collision")
            if len(search) > MAX_BLOCK_SEARCH_CHARS:
                raise PatchFormatError(LIMIT_EXCEEDED, "block_search_chars")
            if len(replace) > MAX_BLOCK_REPLACE_CHARS:
                raise PatchFormatError(LIMIT_EXCEEDED, "block_replace_chars")
            total_blocks += 1
            total_chars += len(search) + len(replace)
            if total_blocks > MAX_PATCH_BLOCKS:
                raise PatchFormatError(LIMIT_EXCEEDED, "patch_blocks")
            if total_chars > MAX_TOTAL_PATCH_CHARS:
                raise PatchFormatError(LIMIT_EXCEEDED, "total_patch_chars")
            per_file[current].append(SearchReplace(search, replace))
            continue
        # any other non-blank line is not part of the frozen grammar
        raise PatchFormatError(SCHEMA_INVALID, "unexpected_line")

    if not order:
        raise PatchFormatError(SCHEMA_INVALID, "no_file_block")
    if len(order) > MAX_FILES_TOUCHED:
        raise PatchFormatError(LIMIT_EXCEEDED, "files_touched")
    for p in order:
        if not per_file[p]:
            raise PatchFormatError(SCHEMA_INVALID, "file_without_block")
    return [(p, per_file[p]) for p in order]


def apply_search_replace(original: str, blocks: list[SearchReplace]) -> str:
    """Apply exact-match SEARCH/REPLACE blocks to ``original`` (one file's pre-image).

    Each SEARCH must occur EXACTLY once in ``original`` (0 → NOT_FOUND, >1 → AMBIGUOUS); the matched
    spans must not overlap; replacements are applied highest-offset-first so earlier edits never shift
    later match positions. No fuzzy matching, no repair.
    """
    spans: list[tuple[int, int, str]] = []
    for sr in blocks:
        count = original.count(sr.search)
        if count == 0:
            raise PatchFormatError(SEARCH_NOT_FOUND)
        if count > 1:
            raise PatchFormatError(SEARCH_AMBIGUOUS)
        start = original.index(sr.search)
        spans.append((start, start + len(sr.search), sr.replace))
    spans.sort(key=lambda s: s[0])
    for a, b in zip(spans, spans[1:]):
        if a[1] > b[0]:
            raise PatchFormatError(OVERLAP)
    out = original
    for start, end, replace in sorted(spans, key=lambda s: -s[0]):
        out = out[:start] + replace + out[end:]
    return out
