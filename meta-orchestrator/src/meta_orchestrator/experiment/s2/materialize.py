"""Read-only source materialization + hash verification for the frozen real corpus ($0 API).

The lean manifest (``corpus/s2_real_corpus.json``) stores only metadata + a ``buggy_source_hash``
per task; the buggy source itself is re-materialised from the pinned revisions at grading time.
This module performs that materialisation for COUNTING / verification, under strict rules:

  * frozen revisions only (``buggy_rev`` from the manifest);
  * exactly the frozen ``allowed_source_files`` — nothing else;
  * a per-task content hash recomputed with the SAME scheme the wiring used, compared to the
    manifest's ``buggy_source_hash``; ONE mismatch marks the whole run unverified (a caller must
    block);
  * the clone cache lives OUTSIDE the config repo (caller-supplied ``cache_dir``);
  * NO fixed source / reference patch is fetched — only the buggy state the agent will see.

It never calls a model and never writes into the config repo or the manifest.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from typing import Optional

from pydantic import BaseModel, Field

_CLONE_TIMEOUT = 600
_FETCH_TIMEOUT = 300


def content_hash(sources: dict[str, str]) -> str:
    """The wiring's hash scheme (``examples/s2_wire_real_corpus.py:_sha``): sorted keys, compact."""
    blob = json.dumps({k: sources[k] for k in sorted(sources)}, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


class MaterializedTaskSource(BaseModel):
    task_id: str
    repo_url: str
    buggy_rev: str
    allowed_source_files: list[str]
    expected_hash: str                 # manifest buggy_source_hash
    computed_hash: str
    verified: bool


class MaterializationReport(BaseModel):
    corpus_manifest_sha256: str
    dataset_commit: str
    n_tasks: int
    n_files: int
    all_verified: bool
    cache_dir: str
    cache_index_hash: str              # hash over (task_id, rev, files, expected_hash) tuples
    per_task: list[MaterializedTaskSource] = Field(default_factory=list)
    mismatches: list[str] = Field(default_factory=list)


def _run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _repo_slug(repo_url: str) -> str:
    return repo_url.rstrip("/").removesuffix(".git").split("/")[-2:][0] + "-" + \
        repo_url.rstrip("/").removesuffix(".git").split("/")[-1]


def _ensure_clone(repo_url: str, cache_dir: str) -> str:
    """Blobless, no-checkout clone (disk-lean); blobs are fetched on demand at cat-file time."""
    dest = os.path.join(cache_dir, _repo_slug(repo_url))
    if not os.path.isdir(os.path.join(dest, ".git")) and not os.path.isdir(os.path.join(dest, "objects")):
        os.makedirs(cache_dir, exist_ok=True)
        r = _run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", repo_url, dest],
                 _CLONE_TIMEOUT)
        if r.returncode != 0:
            raise RuntimeError(f"clone failed for {repo_url}: {r.stderr[:200]}")
    return dest


def _read_file_at_rev(repo_dir: str, rev: str, path: str) -> Optional[str]:
    r = _run(["git", "-C", repo_dir, "cat-file", "-p", f"{rev}:{path}"], _FETCH_TIMEOUT)
    if r.returncode == 0:
        return r.stdout
    # rev may not be reachable from a fetched ref in a blobless clone — fetch it explicitly, retry.
    f = _run(["git", "-C", repo_dir, "fetch", "-q", "--filter=blob:none", "origin", rev],
             _FETCH_TIMEOUT)
    if f.returncode != 0:
        return None
    r = _run(["git", "-C", repo_dir, "cat-file", "-p", f"{rev}:{path}"], _FETCH_TIMEOUT)
    return r.stdout if r.returncode == 0 else None


def materialize_buggy_sources(
    corpus_json_path: str, cache_dir: str, *, task_ids: Optional[list[str]] = None,
) -> tuple[dict[str, dict[str, str]], MaterializationReport]:
    """Materialise + hash-verify the buggy source of each task. Returns (sources, report).

    ``sources`` maps task_id → {path: content} for the VERIFIED tasks. The report's
    ``all_verified`` is False if any task's hash mismatched or any file could not be read; the
    caller MUST block the gate on ``all_verified is False``.
    """
    doc = json.load(open(corpus_json_path))
    tasks = doc["tasks"]
    ids = task_ids if task_ids is not None else list(tasks)

    sources: dict[str, dict[str, str]] = {}
    per_task: list[MaterializedTaskSource] = []
    mismatches: list[str] = []
    n_files = 0
    index_tuples = []

    for tid in ids:
        e = tasks[tid]
        repo_url, rev = e["repo_url"], e["buggy_rev"]
        files = list(e["allowed_source_files"])
        expected = e["buggy_source_hash"]
        index_tuples.append((tid, rev, tuple(sorted(files)), expected))
        repo_dir = _ensure_clone(repo_url, cache_dir)
        src: dict[str, str] = {}
        read_ok = True
        for p in files:
            content = _read_file_at_rev(repo_dir, rev, p)
            if content is None:
                read_ok = False
                mismatches.append(f"{tid}:unreadable:{p}")
                break
            src[p] = content
        computed = content_hash(src) if read_ok else ""
        verified = read_ok and computed == expected
        if read_ok and not verified:
            mismatches.append(f"{tid}:hash {computed}!={expected}")
        if verified:
            sources[tid] = src
            n_files += len(src)
        per_task.append(MaterializedTaskSource(
            task_id=tid, repo_url=repo_url, buggy_rev=rev, allowed_source_files=sorted(files),
            expected_hash=expected, computed_hash=computed, verified=verified))

    idx_blob = json.dumps(sorted(index_tuples), separators=(",", ":"))
    report = MaterializationReport(
        corpus_manifest_sha256=doc.get("corpus_manifest_sha256", ""),
        dataset_commit=doc.get("dataset_commit", ""),
        n_tasks=len(ids), n_files=n_files,
        all_verified=(not mismatches and len(sources) == len(ids)),
        cache_dir=cache_dir,
        cache_index_hash=hashlib.sha256(idx_blob.encode()).hexdigest()[:16],
        per_task=per_task, mismatches=mismatches)
    return sources, report
