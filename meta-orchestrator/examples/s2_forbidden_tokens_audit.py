"""$0 audit of the frozen provenance-aware reference-fix leakage screen (s2_forbidden_tokens.frozen).

Offline / no model call. Prints, per task: forbidden-token count, the tokens, and their frozen
corpus document frequency; then asserts the screen is sound: content-hash valid, every token is
corpus-unique (df<=1), no ordinary English / keyword / builtin words slipped in, and black-112 (the
task being re-run) has ZERO forbidden tokens so its learning path is unobstructed. Exits non-zero on
any violation.

Usage: python examples/s2_forbidden_tokens_audit.py
"""
from __future__ import annotations

import builtins
import keyword
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "src"))

from meta_orchestrator.experiment.s2.forbidden_tokens import load_frozen_forbidden_tokens  # noqa: E402

# A sanity denylist: ordinary words that must NEVER be a forbidden token (the old screen leaked these
# from comments/docstrings). This is a tripwire, not the extraction rule (extraction is provenance +
# rarity, no dictionary).
_MUST_NOT_BE_FORBIDDEN = {
    "behavior", "however", "because", "example", "copyright", "agreement", "contributor",
    "foundation", "google", "exception", "comment", "result", "value", "parser", "tokenizer",
    "output", "input", "return", "function", "whitespace", "formatting",
}


def main() -> None:
    ft = load_frozen_forbidden_tokens(os.path.join(HERE, "corpus"))
    problems: list[str] = []
    kw = set(keyword.kwlist) | set(getattr(keyword, "softkwlist", [])) | set(dir(builtins))

    total = 0
    print(f"forbidden-token screen [{ft.content_hash}] version={ft.schema_version} match={ft.match} "
          f"min_ident_len={ft.min_ident_len}")
    print("-" * 84)
    for tid in sorted(ft.tasks):
        rec = ft.tasks[tid]
        forb = rec["forbidden"]
        total += len(forb)
        print(f"  {tid:16} {rec['family']:20} n={len(forb):<2} {sorted(forb)}")
        for tok, prov in forb.items():
            if prov.get("corpus_df", 99) > 1:
                problems.append(f"{tid}:{tok} corpus_df>1 ({prov.get('corpus_df')})")
            if tok in kw:
                problems.append(f"{tid}:{tok} is a keyword/builtin")
            if tok.lower() in _MUST_NOT_BE_FORBIDDEN:
                problems.append(f"{tid}:{tok} is an ordinary word (denylist tripwire)")
            if len(tok) < ft.min_ident_len and not tok.isupper():
                problems.append(f"{tid}:{tok} shorter than min_ident_len")

    print("-" * 84)
    print(f"total forbidden tokens = {total} across {len(ft.tasks)} tasks")
    print(f"black-112 forbidden = {ft.for_task('black-112')} (must be empty for the re-run)")
    if ft.for_task("black-112"):
        problems.append("black-112 has forbidden tokens — its learning path would be obstructed")
    if problems:
        for p in problems:
            print("  FAIL:", p)
        raise SystemExit(f"FORBIDDEN-TOKEN AUDIT FAILED — {len(problems)} problem(s)")
    print("AUDIT PASSED — all tokens are corpus-unique fix identifiers; no ordinary words; "
          "black-112 unobstructed.")


if __name__ == "__main__":
    main()
