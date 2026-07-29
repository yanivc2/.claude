"""Content-addressed handoff bundle + verifier — the boundary seal to the pilot env (final $0).

The bundle records OBSERVATIONS + per-file hashes only (never a ``ready=true`` claim). Its
authoritative integrity is the file inventory (each critical file's sha256) plus a SEPARATE seal
file holding the sha256 of the manifest itself (a manifest cannot hash itself). git commit/tree are
provenance observations; the content-addressed inventory is the real check (robust to the fact that
committing the bundle shifts HEAD/tree). ``verify_handoff`` is the single, only command a fresh
pilot env runs FIRST — exit 0 is the precondition for standing up the pinned environment.

Honest scope: corruption / transfer-error / stale-restore detection — not defence against an
adversary who rewrites the manifest, the seal, and this code together.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
from typing import Optional

from pydantic import BaseModel, Field

SCHEMA_VERSION = "s2-handoff-v1"

# Critical files whose content is sealed into the bundle (globs, repo-relative).
CRITICAL_GLOBS = [
    "src/meta_orchestrator/experiment/s2/*.py",
    "tests/test_s2_*.py",
    "corpus/S2_*.md",
    "corpus/S2_*.txt",
    "corpus/s2_*.json",
    "corpus/d_playbook.frozen.json",
    "corpus/pybughive_gate1_manifest.json",
    "examples/s2_*.py",
]

# The bundle's own files are never part of its own inventory (a manifest can't hash itself).
_BUNDLE_FILES = {"corpus/S2_PILOT_HANDOFF_MANIFEST.json", "corpus/S2_PILOT_HANDOFF_MANIFEST.sha256"}

# The SDK tests that MUST run (not skip) in the pilot env — the production-path MockTransport tests.
REQUIRED_PILOT_NODE_IDS = [
    "tests/test_s2_prepaid.py::test_sdk_serialized_body_omits_effort_and_temperature",
    "tests/test_s2_prepaid.py::test_sdk_max_retries_zero_means_one_http_request",
]


class FileEntry(BaseModel):
    path: str
    sha256: str
    size: int
    type: str
    mode: str


class VerifyResult(BaseModel):
    ok: bool
    reasons: list[str] = Field(default_factory=list)


def _sha256_file(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def _ftype(path: str) -> str:
    return {".py": "python", ".json": "json", ".md": "markdown", ".txt": "text",
            ".sha256": "seal"}.get(os.path.splitext(path)[1], "other")


def _git(args: list[str], cwd: str) -> str:
    try:
        return subprocess.check_output(["git", *args], cwd=cwd, text=True,
                                       stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""


def _worktree_clean_ignoring_bundle(repo_root: str) -> bool:
    """Worktree (this subtree) is 'clean' for handoff if the only dirty paths are the bundle's own
    files. Handles a nested git repo: status paths are relative to the git toplevel, so the bundle
    files are compared with the subtree prefix applied."""
    prefix = _git(["rev-parse", "--show-prefix"], repo_root)     # e.g. "meta-orchestrator/" or ""
    ignore = {prefix + b for b in _BUNDLE_FILES}
    # scope to this subtree ('.') so unrelated changes elsewhere in the outer repo are not counted.
    lines = [ln for ln in _git(["status", "--porcelain", "."], repo_root).splitlines() if ln.strip()]
    for ln in lines:
        path = ln[3:].strip()
        if path not in ignore:
            return False
    return True


def _glob_critical(repo_root: str) -> list[str]:
    import glob
    found: set[str] = set()
    for pat in CRITICAL_GLOBS:
        for p in glob.glob(os.path.join(repo_root, pat)):
            rel = os.path.relpath(p, repo_root)
            if rel not in _BUNDLE_FILES:               # never inventory the bundle's own files
                found.add(rel)
    return sorted(found)


def _safe_rel(repo_root: str, rel: str) -> Optional[str]:
    """Return the absolute path iff ``rel`` is a safe repo-relative, non-symlink path; else None."""
    if os.path.isabs(rel) or ".." in rel.split("/"):
        return None
    ap = os.path.join(repo_root, rel)
    if os.path.islink(ap):
        return None
    if os.path.realpath(ap) != os.path.abspath(ap):
        return None
    return ap


def build_handoff_manifest(repo_root: str, *, run_id: str, bundle_id: str, created_at: str,
                           offline_passed: int, offline_skipped: int) -> tuple[dict, str]:
    """Build the manifest (observations only) + return (manifest_dict, seal_sha256)."""
    inventory: list[FileEntry] = []
    for rel in _glob_critical(repo_root):
        ap = os.path.join(repo_root, rel)
        st = os.stat(ap)
        inventory.append(FileEntry(path=rel, sha256=_sha256_file(ap), size=st.st_size,
                                   type=_ftype(rel), mode=oct(stat.S_IMODE(st.st_mode))))
    lockfiles = {}
    for cand in ("poetry.lock", "requirements.txt", "requirements.lock", "uv.lock",
                 "pyproject.toml"):
        p = os.path.join(repo_root, cand)
        if os.path.exists(p):
            lockfiles[cand] = _sha256_file(p)
    inventory_hash = hashlib.sha256(
        json.dumps([e.model_dump() for e in inventory], sort_keys=True).encode()).hexdigest()
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "bundle_id": bundle_id,
        "run_id": run_id,
        "created_at": created_at,               # provenance only
        "git_commit": _git(["rev-parse", "HEAD"], repo_root),
        "git_tree_hash": _git(["rev-parse", "HEAD^{tree}"], repo_root),
        # ignore the bundle's OWN (still-untracked) files when observing worktree cleanliness.
        "clean_worktree": _worktree_clean_ignoring_bundle(repo_root),
        "lockfiles": lockfiles,
        "content_inventory_hash": inventory_hash,
        "inventory": [e.model_dump() for e in inventory],
        "required_pilot_node_ids": REQUIRED_PILOT_NODE_IDS,
        "must_run_in_pilot_env": True,
        "tests": {
            "offline_expected": {"passed": offline_passed, "skipped": offline_skipped},
            "pilot_env_required": {"failed": 0, "skipped": 0},
        },
        "authorization_state": "UNAUTHORIZED_FOR_MESSAGES",
        "paid_api_called": False,
        "production_token_artifacts_present": False,
        "note": ("authoritative integrity = the content inventory + the separate .sha256 seal; "
                 "git fields are provenance (committing the bundle shifts HEAD/tree). This is "
                 "corruption/transfer-error detection, not adversarial security."),
    }
    seal = hashlib.sha256(_canonical_bytes(manifest)).hexdigest()
    return manifest, seal


def _canonical_bytes(manifest: dict) -> bytes:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()


def verify_handoff(repo_root: str, manifest_path: str, seal_path: str) -> VerifyResult:
    """The FIRST command a fresh pilot env runs. Any mismatch → not ok (nonzero exit for the CLI)."""
    reasons: list[str] = []
    manifest = json.load(open(manifest_path))

    # 1) seal first — the manifest must match its separate sha256 seal.
    expected_seal = open(seal_path).read().strip().split()[0]
    if hashlib.sha256(_canonical_bytes(manifest)).hexdigest() != expected_seal:
        reasons.append("seal_mismatch (manifest edited after sealing)")
        return VerifyResult(ok=False, reasons=reasons)   # stop early — nothing else is trustworthy

    # 2) unambiguous unauthorized status (observations, verified live below too).
    if manifest.get("authorization_state") != "UNAUTHORIZED_FOR_MESSAGES":
        reasons.append("handoff carries an AUTHORIZED status")
    if manifest.get("paid_api_called") is not False:
        reasons.append("paid_api_called is not false")
    if manifest.get("production_token_artifacts_present") is not False:
        reasons.append("production_token_artifacts_present is not false")

    # 3) recompute every inventoried file hash; reject symlink / traversal / mode change / missing.
    listed = set()
    for entry in manifest.get("inventory", []):
        rel = entry["path"]
        listed.add(rel)
        ap = _safe_rel(repo_root, rel)
        if ap is None:
            reasons.append(f"unsafe_path (symlink/traversal): {rel}")
            continue
        if not os.path.exists(ap):
            reasons.append(f"missing_critical_file: {rel}")
            continue
        st = os.stat(ap)
        if _sha256_file(ap) != entry["sha256"]:
            reasons.append(f"content_changed: {rel}")
        if entry.get("size") != st.st_size:
            reasons.append(f"size_changed: {rel}")
        if entry.get("mode") and entry["mode"] != oct(stat.S_IMODE(st.st_mode)):
            reasons.append(f"mode_changed: {rel}")

    # 4) no EXTRA critical file that is not in the inventory.
    live = set(_glob_critical(repo_root))
    extra = live - listed
    if extra:
        reasons.append(f"extra_critical_files_not_in_bundle: {sorted(extra)[:5]}")

    # 5) content-inventory aggregate hash reproduces.
    recomputed = hashlib.sha256(json.dumps(manifest["inventory"], sort_keys=True).encode()).hexdigest()
    if recomputed != manifest.get("content_inventory_hash"):
        reasons.append("content_inventory_hash_mismatch")

    # 6) git provenance — worktree clean apart from the bundle's own files; recorded commit present.
    if not _worktree_clean_ignoring_bundle(repo_root):
        reasons.append("worktree_not_clean (setup modified the repo)")
    if manifest.get("git_commit") and not _git(["cat-file", "-e", manifest["git_commit"]], repo_root) == "":
        pass  # cat-file -e returns empty on success; a bad commit raises → empty string handling below
    if manifest.get("git_commit") and _git(["rev-parse", "--verify", manifest["git_commit"] + "^{commit}"], repo_root) == "":
        reasons.append("recorded_git_commit_not_found")

    # 7) required pilot node IDs are present + flagged must-run.
    if manifest.get("required_pilot_node_ids") != REQUIRED_PILOT_NODE_IDS:
        reasons.append("required_pilot_node_ids_mismatch")
    if manifest.get("must_run_in_pilot_env") is not True:
        reasons.append("must_run_in_pilot_env_not_set")
    if manifest.get("tests", {}).get("pilot_env_required") != {"failed": 0, "skipped": 0}:
        reasons.append("pilot_env_required_policy_missing")

    # 8) no bundled file may declare a production token count (proxy posing as production, or a
    #    stray real artifact before the pilot).
    for entry in manifest.get("inventory", []):
        ap = _safe_rel(repo_root, entry["path"])
        if ap and entry["path"].endswith(".json") and os.path.exists(ap):
            try:
                if "anthropic_count_tokens" in open(ap, "r", errors="ignore").read():
                    reasons.append(f"production_token_artifact_in_bundle: {entry['path']}")
            except Exception:
                pass

    return VerifyResult(ok=not reasons, reasons=reasons)
