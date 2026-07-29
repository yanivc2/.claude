"""Offline tests for the read-only source materialisation + hash-verification logic.

Git/network access is monkeypatched, so these run deterministically in the offline suite. They
prove the hash scheme matches the wiring, that ONE mismatch (or one unreadable file) blocks, and
that ONLY the frozen allowed_source_files are read (no fixed source / reference patch).
"""
from __future__ import annotations

import hashlib
import json

from meta_orchestrator.experiment.s2 import materialize as M


def _wiring_sha(sources: dict[str, str]) -> str:
    blob = json.dumps({k: sources[k] for k in sorted(sources)}, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def test_content_hash_matches_wiring_scheme():
    src = {"b.py": "def g(): return 2\n", "a.py": "def f(): return 1\n"}
    assert M.content_hash(src) == _wiring_sha(src)


def _write_corpus(tmp_path, expected_hash: str, files=("pkg/a.py", "pkg/b.py")):
    doc = {"corpus_manifest_sha256": "manifest123", "dataset_commit": "deadbeef",
           "tasks": {"repo-1": {"repo_url": "https://github.com/acme/repo", "buggy_rev": "abc123",
                                "allowed_source_files": list(files),
                                "buggy_source_hash": expected_hash}}}
    p = tmp_path / "corpus.json"
    p.write_text(json.dumps(doc))
    return str(p)


def _canned(monkeypatch, contents: dict[str, str | None], seen: list | None = None):
    monkeypatch.setattr(M, "_ensure_clone", lambda repo_url, cache_dir: "/fake/repo")
    def fake_read(repo_dir, rev, path):
        if seen is not None:
            seen.append(path)
        return contents.get(path)
    monkeypatch.setattr(M, "_read_file_at_rev", fake_read)


def test_materialize_verifies_matching_hash(tmp_path, monkeypatch):
    content = {"pkg/a.py": "A\n", "pkg/b.py": "B\n"}
    corpus = _write_corpus(tmp_path, M.content_hash(content))
    _canned(monkeypatch, content)
    sources, rep = M.materialize_buggy_sources(corpus, str(tmp_path / "cache"))
    assert rep.all_verified is True
    assert sources["repo-1"] == content
    assert rep.n_tasks == 1 and rep.n_files == 2 and not rep.mismatches
    assert rep.cache_index_hash and rep.corpus_manifest_sha256 == "manifest123"


def test_hash_mismatch_blocks(tmp_path, monkeypatch):
    corpus = _write_corpus(tmp_path, "0000deadbeef")            # wrong expected hash
    _canned(monkeypatch, {"pkg/a.py": "A\n", "pkg/b.py": "B\n"})
    sources, rep = M.materialize_buggy_sources(corpus, str(tmp_path / "cache"))
    assert rep.all_verified is False                            # caller MUST block
    assert "repo-1" not in sources
    assert any(m.startswith("repo-1:hash ") for m in rep.mismatches)


def test_unreadable_file_blocks(tmp_path, monkeypatch):
    content = {"pkg/a.py": "A\n", "pkg/b.py": "B\n"}
    corpus = _write_corpus(tmp_path, M.content_hash(content))
    _canned(monkeypatch, {"pkg/a.py": "A\n", "pkg/b.py": None})  # second file cannot be read
    sources, rep = M.materialize_buggy_sources(corpus, str(tmp_path / "cache"))
    assert rep.all_verified is False
    assert "repo-1" not in sources
    assert any("unreadable" in m for m in rep.mismatches)


def test_reads_only_allowed_files(tmp_path, monkeypatch):
    content = {"pkg/a.py": "A\n", "pkg/b.py": "B\n"}
    corpus = _write_corpus(tmp_path, M.content_hash(content))
    seen: list[str] = []
    _canned(monkeypatch, content, seen=seen)
    M.materialize_buggy_sources(corpus, str(tmp_path / "cache"))
    assert sorted(seen) == ["pkg/a.py", "pkg/b.py"]            # exactly the allowed files, no others
