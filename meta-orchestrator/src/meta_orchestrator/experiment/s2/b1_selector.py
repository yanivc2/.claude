"""B1 parity-optimized derangement selector (frozen algorithm — user decision, 2026-07-18).

B1 must isolate RELEVANCE, not text length or bank occupancy. A single fixed rotation can hand
B1 fewer lines/tokens than C on some tasks (collapsing B1 toward A). So, per fold, AFTER C's
bank is frozen and BEFORE any held-out call, we pick the wrong-family mapping that matches C's
occupancy, by a deterministic algorithm frozen here:

  1. enumerate all derangements (permutations with NO fixed point) over the present families;
  2. for each held-out family, compute what C injects vs what B1 would inject under the mapping;
  3. a mapping QUALIFIES only if, for every held-out family: entries(B1)==entries(C),
     lines(B1)==lines(C), and |tokens(B1)-tokens(C)| <= 16 AND <= 5% of tokens(C);
  4. among qualified mappings pick: min(max token diff) → min(sum token diffs) → lexicographic
     tie-break on sorted(mapping.items());
  5. if NONE qualifies, the fold is BLOCKED before any held-out call — no padding, duplication,
     truncation, or fallback to A;
  6. emit a per-fold artifact hash-locked to the frozen C bank (bank hash, algo version, token-fn
     name, chosen mapping, per-family metrics, content hash).

The mapping is a function of the FROZEN bank + text structure ONLY — never held-out outcomes.
The token function is injectable so the pilot can pass the exact ``count_tokens`` used for the
context-cap preflight; offline it defaults to a deterministic local estimate.
"""
from __future__ import annotations

import hashlib
import json
import re
from itertools import permutations
from typing import Callable, Optional

from pydantic import BaseModel, Field

from .memory import SLOT_MAX_CHARS, SLOT_MAX_LINES, FrozenLessonBank, PlaceboRouter

B1_SELECTOR_ALGO_VERSION = "b1-parity-v1"
TOKEN_ABS_TOLERANCE = 16
TOKEN_REL_TOLERANCE = 0.05

TokenFn = Callable[[str], int]


def local_token_estimate(text: str) -> int:
    """Deterministic offline token proxy (name: 'local-v1'). Words + individual punctuation."""
    return len(re.findall(r"\w+|[^\w\s]", text))


local_token_estimate.fn_name = "local-v1"          # type: ignore[attr-defined]


class B1SelectionBlocked(RuntimeError):
    """No wrong-family derangement met the parity bar — the fold is blocked before held-out."""


class FamilyParity(BaseModel):
    family: str
    mapped_family: str
    c_entries: int
    b1_entries: int
    c_lines: int
    b1_lines: int
    c_tokens: int
    b1_tokens: int
    token_diff: int


class B1Selection(BaseModel):
    fold: int
    algo_version: str = B1_SELECTOR_ALGO_VERSION
    token_fn_name: str
    c_bank_hash: str
    mapping: dict[str, str]
    metrics: list[FamilyParity]
    max_token_diff: int
    sum_token_diff: int

    def content_hash(self) -> str:
        blob = json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]

    def router(self) -> PlaceboRouter:
        return PlaceboRouter(mapping=dict(self.mapping))


def _payload(lessons) -> tuple[int, int, str]:
    """(entries, rendered-line count, joined bullet text) under the SAME slot caps as render_lines."""
    bullets: list[str] = []
    for l in lessons:
        bullets.extend(l.recommended_action)
        bullets.extend(f"avoid: {a}" for a in l.avoid)
    capped = [ln[:SLOT_MAX_CHARS] for ln in bullets[:SLOT_MAX_LINES]]
    return len(lessons), len(capped), "\n".join(capped)


def enumerate_derangements(families: list[str]) -> list[dict[str, str]]:
    fams = sorted(set(families))
    out: list[dict[str, str]] = []
    for perm in permutations(fams):
        mapping = dict(zip(fams, perm))
        if all(mapping[f] != f for f in fams):
            out.append(mapping)
    return out


def _within_tolerance(c_tokens: int, b1_tokens: int) -> bool:
    diff = abs(b1_tokens - c_tokens)
    if diff > TOKEN_ABS_TOLERANCE:
        return False
    if c_tokens == 0:
        return diff == 0                            # C injects nothing → B1 must inject nothing
    return diff <= TOKEN_REL_TOLERANCE * c_tokens


def select_b1_derangement(
    bank: FrozenLessonBank,
    present_families: list[str],
    held_out_families: list[str],
    *,
    fold: int,
    token_fn: Optional[TokenFn] = None,
) -> B1Selection:
    """Pick the parity-optimized wrong-family mapping for one fold, or raise B1SelectionBlocked."""
    token_fn = token_fn or local_token_estimate
    token_fn_name = getattr(token_fn, "fn_name", getattr(token_fn, "__name__", "custom"))
    held = sorted(set(held_out_families))

    # C's per-family injection is mapping-independent; compute once.
    c_metrics = {}
    for fam in held:
        e, ln, text = _payload(bank.lessons_for(fam))
        c_metrics[fam] = (e, ln, token_fn(text))

    best: Optional[tuple] = None                    # (max_diff, sum_diff, mapping_key, mapping, metrics)
    for mapping in enumerate_derangements(present_families):
        rows: list[FamilyParity] = []
        ok = True
        diffs: list[int] = []
        for fam in held:
            ce, cl, ct = c_metrics[fam]
            be, bl, btext = _payload(bank.lessons_for(mapping[fam]))
            bt = token_fn(btext)
            diff = abs(bt - ct)
            if be != ce or bl != cl or not _within_tolerance(ct, bt):
                ok = False
                break
            diffs.append(diff)
            rows.append(FamilyParity(family=fam, mapped_family=mapping[fam], c_entries=ce,
                                     b1_entries=be, c_lines=cl, b1_lines=bl, c_tokens=ct,
                                     b1_tokens=bt, token_diff=diff))
        if not ok:
            continue
        max_diff, sum_diff = (max(diffs) if diffs else 0), sum(diffs)
        key = json.dumps(sorted(mapping.items()), separators=(",", ":"))   # frozen tie-break
        cand = (max_diff, sum_diff, key, mapping, rows)
        if best is None or cand[:3] < best[:3]:
            best = cand

    if best is None:
        raise B1SelectionBlocked(
            f"fold {fold}: no wrong-family derangement meets entries/lines parity + token "
            f"tolerance (<= {TOKEN_ABS_TOLERANCE} and <= {TOKEN_REL_TOLERANCE:.0%}); "
            "fold blocked before held-out (no padding/truncation/fallback).")
    max_diff, sum_diff, _key, mapping, rows = best
    return B1Selection(fold=fold, token_fn_name=token_fn_name, c_bank_hash=bank.content_hash(),
                       mapping=mapping, metrics=rows, max_token_diff=max_diff,
                       sum_token_diff=sum_diff)
