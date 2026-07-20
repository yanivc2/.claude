"""Build the FROZEN, provenance-aware reference-fix leakage screen (s2_forbidden_tokens.frozen.json).

Replaces the over-broad ``reference_patch_tokens`` (which pulled 431 tokens from FULL reference-fix
files, including ordinary English words from comments/docstrings/license headers). A forbidden token
must satisfy ALL of:

  (a) provenance — it appears ONLY in an added/replaced PRODUCTION-code line of the reference diff
      (buggy vs fixed), never derived from the whole file, unchanged context, comments or docstrings;
  (b) kind — a newly introduced identifier (or numeric literal); comments, docstrings and string
      contents are excluded entirely;
  (c) public-absence — it is NOT visible to the model: absent from the buggy source AND the sanitized
      public statement (so it cannot be "leaked from the fix" — it was already public);
  (d) rarity — corpus document frequency <= 1 (it is unique to a single task's changed lines).

Matching downstream is EXACT-token (whole word), never substring. Offline / no model call, but it
clones the source repos to read the diffs (git only, no venv/build).

Usage: python examples/s2_build_forbidden_tokens.py <workdir> [--write]
"""
from __future__ import annotations

import builtins
import difflib
import io
import json
import keyword
import os
import subprocess
import sys
import tokenize as pytok

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "src"))
CORPUS = os.path.join(HERE, "corpus")

FROZEN_FORBIDDEN_FILENAME = "s2_forbidden_tokens.frozen.json"
FORBIDDEN_TOKENS_VERSION = "s2-forbidden-tokens-v1"
MIN_IDENT_LEN = 3                     # ignore trivial 1-2 char names (never uniquely identifying)

_STOP = set(keyword.kwlist) | set(getattr(keyword, "softkwlist", [])) | set(dir(builtins))


def _run(args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


def _git_show(repo, ref, path):
    r = _run(["git", "show", f"{ref}:{path}"], cwd=repo)
    return r.stdout if r.returncode == 0 else None


def _added_line_numbers(buggy_text: str, fixed_text: str) -> set[int]:
    """1-indexed line numbers in the FIXED file that are added/replaced vs the buggy file."""
    b = buggy_text.splitlines()
    f = fixed_text.splitlines()
    added: set[int] = set()
    sm = difflib.SequenceMatcher(a=b, b=f, autojunk=False)
    for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
        if tag in ("insert", "replace"):
            added.update(range(j1 + 1, j2 + 1))       # j is 0-indexed into f → +1 for 1-indexed
    return added


def _code_idents_on_lines(fixed_text: str, lines: set[int]) -> set[str]:
    """Identifiers (+ numeric literals) that occur on the given FIXED lines, EXCLUDING comments,
    strings and docstrings (only real code NAME/NUMBER tokens count)."""
    out: set[str] = set()
    try:
        toks = list(pytok.generate_tokens(io.StringIO(fixed_text).readline))
    except (pytok.TokenError, IndentationError, SyntaxError):
        # non-parseable (e.g. partial/py2) → conservative regex fallback, still line-scoped
        import re
        for i, ln in enumerate(fixed_text.splitlines(), 1):
            if i in lines:
                code = ln.split("#", 1)[0]
                for m in re.findall(r"[A-Za-z_]\w+", code):
                    if len(m) >= MIN_IDENT_LEN and m not in _STOP:
                        out.add(m)
        return out
    for tok in toks:
        if tok.start[0] not in lines:
            continue
        if tok.type == pytok.NAME and tok.string not in _STOP and len(tok.string) >= MIN_IDENT_LEN:
            out.add(tok.string)
        # NUMBER / COMMENT / STRING (incl. docstrings) are intentionally ignored: numeric literals are
        # common in prose ("2 spaces") and are not a symbol-replay vector — a concrete numeric ANSWER
        # is already blocked by the concrete-value rule and by hidden-test forbidden values.
    return out


def _public_tokens(buggy_source: dict, statement: str) -> set[str]:
    """Every whole-word token the model can already see (buggy source + public statement)."""
    import re
    seen: set[str] = set()
    for text in [*buggy_source.values(), statement or ""]:
        for m in re.findall(r"[A-Za-z_]\w+", text):
            seen.add(m)
    return seen


def main() -> None:
    workdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "_forbidden_work")
    do_write = "--write" in sys.argv[2:]
    os.makedirs(workdir, exist_ok=True)

    fmap = json.load(open(os.path.join(CORPUS, "s2_family_map.json")))["family_map"]
    scope = {t["task_id"]: t for t in json.load(open(os.path.join(CORPUS, "s2_scope_metadata.json")))["tasks"]}
    corpus = json.load(open(os.path.join(CORPUS, "s2_real_corpus.json")))["tasks"]

    pb = os.path.join(workdir, "_pybughive")
    if not os.path.isdir(pb):
        _run(["git", "clone", "-q", "--depth", "1", "https://github.com/pybughive/pybughive", pb])
    dataset = json.load(open(os.path.join(pb, "dataset", "pybughive_current.json")))
    issue_by_id = {f"{p['repository']}-{iss['id']}": (p, iss) for p in dataset for iss in p["issues"]}

    per_task_candidates: dict[str, dict] = {}
    for tid in sorted(scope):
        proj, iss = issue_by_id[tid]
        owner, project = proj["username"], proj["repository"]
        repo = os.path.join(workdir, project)
        if not os.path.isdir(repo):
            print(f"cloning {owner}/{project} …")
            c = _run(["git", "clone", "-q", f"https://github.com/{owner}/{project}", repo])
            if c.returncode != 0:
                raise SystemExit(f"clone failed for {owner}/{project}: {c.stderr[:200]}")
        commit = iss["commits"][0]
        fixed, buggy = commit["hash"], commit["parents"].split(",")[0].strip()
        allowed = sorted(scope[tid]["allowed_source_files"])
        statement = corpus[tid]["sanitized_statement"]
        buggy_source, cand = {}, {}
        for path in allowed:
            b = _git_show(repo, buggy, path)
            f = _git_show(repo, fixed, path)
            if b is None or f is None:
                raise SystemExit(f"{tid}: cannot read {path} at buggy/fixed")
            buggy_source[path] = b
            added = _added_line_numbers(b, f)
            for tok in _code_idents_on_lines(f, added):
                cand.setdefault(tok, {"file": path})
        public = _public_tokens(buggy_source, statement)
        cand = {t: prov for t, prov in cand.items() if t not in public}   # (c) public-absence
        per_task_candidates[tid] = {"family": fmap[tid], "candidates": cand}
        print(f"  {tid:16} {fmap[tid]:20} candidate_new_code_idents={len(cand)}")

    # (d) corpus rarity: keep only tokens whose document frequency across tasks is <= 1
    df: dict[str, int] = {}
    for tid, rec in per_task_candidates.items():
        for tok in rec["candidates"]:
            df[tok] = df.get(tok, 0) + 1
    frozen = {"schema_version": FORBIDDEN_TOKENS_VERSION, "min_ident_len": MIN_IDENT_LEN,
              "match": "exact-token", "tasks": {}}
    total = 0
    for tid, rec in per_task_candidates.items():
        kept = {t: {**prov, "corpus_df": df[t]} for t, prov in rec["candidates"].items() if df[t] <= 1}
        frozen["tasks"][tid] = {"family": rec["family"], "forbidden": kept}
        total += len(kept)
    import hashlib
    payload = json.dumps(frozen, sort_keys=True, separators=(",", ":"))
    frozen["content_hash"] = hashlib.sha256(payload.encode()).hexdigest()[:16]

    print("=" * 78)
    print(f"forbidden tokens (df<=1, provenance-aware): {total} across {len(frozen['tasks'])} tasks; "
          f"content_hash={frozen['content_hash']}")
    if do_write:
        out = os.path.join(CORPUS, FROZEN_FORBIDDEN_FILENAME)
        with open(out, "w") as fh:
            fh.write(json.dumps(frozen, indent=2, sort_keys=True) + "\n")
        print(f"WROTE {out}")
    else:
        print("(dry run — pass --write to freeze)")


if __name__ == "__main__":
    main()
