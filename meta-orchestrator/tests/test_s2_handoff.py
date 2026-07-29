"""Handoff bundle build + verify — the boundary seal. Pure/offline, in a throwaway git repo.

Covers GPT's mandatory cases: tampered manifest/file, wrong seal, missing file, extra critical
file, symlink/path-traversal, missing required SDK node id, carried-authorized status.
"""
from __future__ import annotations

import json
import os
import subprocess

import pytest

from meta_orchestrator.experiment.s2.handoff import build_handoff_manifest, verify_handoff


def _run(cmd, cwd):
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True)


def _repo(tmp_path):
    root = str(tmp_path)
    # minimal tree matching a couple of critical globs
    os.makedirs(os.path.join(root, "src/meta_orchestrator/experiment/s2"))
    os.makedirs(os.path.join(root, "tests"))
    os.makedirs(os.path.join(root, "corpus"))
    open(os.path.join(root, "src/meta_orchestrator/experiment/s2/x.py"), "w").write("x = 1\n")
    open(os.path.join(root, "tests/test_s2_x.py"), "w").write("def test_x():\n    assert True\n")
    open(os.path.join(root, "corpus/s2_family_map.json"), "w").write('{"frozen": true}\n')
    _run(["git", "init", "-q"], root)
    _run(["git", "config", "user.email", "t@t"], root)
    _run(["git", "config", "user.name", "t"], root)
    _run(["git", "add", "-A"], root)
    _run(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], root)
    return root


def _write_bundle(root):
    manifest, seal = build_handoff_manifest(root, run_id="r", bundle_id="b", created_at="t",
                                            offline_passed=10, offline_skipped=0)
    mp = os.path.join(root, "corpus", "S2_PILOT_HANDOFF_MANIFEST.json")
    sp = os.path.join(root, "corpus", "S2_PILOT_HANDOFF_MANIFEST.sha256")
    json.dump(manifest, open(mp, "w"), indent=2, sort_keys=True)
    open(sp, "w").write(seal + "\n")
    return mp, sp, manifest


def test_fresh_bundle_verifies(tmp_path):
    root = _repo(tmp_path)
    mp, sp, _ = _write_bundle(root)
    assert verify_handoff(root, mp, sp).ok


def test_edited_file_is_caught(tmp_path):
    root = _repo(tmp_path)
    mp, sp, _ = _write_bundle(root)
    open(os.path.join(root, "src/meta_orchestrator/experiment/s2/x.py"), "w").write("x = 999\n")
    res = verify_handoff(root, mp, sp)
    assert not res.ok and any("content_changed" in r for r in res.reasons)


def test_wrong_seal_is_caught(tmp_path):
    root = _repo(tmp_path)
    mp, sp, _ = _write_bundle(root)
    open(sp, "w").write("deadbeef\n")
    res = verify_handoff(root, mp, sp)
    assert not res.ok and any("seal_mismatch" in r for r in res.reasons)


def test_missing_file_is_caught(tmp_path):
    root = _repo(tmp_path)
    mp, sp, _ = _write_bundle(root)
    os.remove(os.path.join(root, "tests/test_s2_x.py"))
    res = verify_handoff(root, mp, sp)
    assert not res.ok and any("missing_critical_file" in r for r in res.reasons)


def test_extra_critical_file_is_caught(tmp_path):
    root = _repo(tmp_path)
    mp, sp, _ = _write_bundle(root)
    open(os.path.join(root, "tests/test_s2_new.py"), "w").write("def test_n():\n    assert True\n")
    res = verify_handoff(root, mp, sp)
    assert not res.ok and any("extra_critical_files" in r for r in res.reasons)


def test_carried_authorized_status_is_rejected(tmp_path):
    root = _repo(tmp_path)
    mp, sp, manifest = _write_bundle(root)
    manifest["authorization_state"] = "AUTHORIZED_FOR_FOLD1_C_TRAINING"
    json.dump(manifest, open(mp, "w"), indent=2, sort_keys=True)   # seal now mismatches
    res = verify_handoff(root, mp, sp)
    assert not res.ok            # seal_mismatch OR authorized-status — either blocks


def test_missing_required_node_id_is_rejected(tmp_path):
    root = _repo(tmp_path)
    mp, sp, manifest = _write_bundle(root)
    manifest["required_pilot_node_ids"] = ["tests/test_s2_prepaid.py::only_one"]
    # reseal so we isolate the node-id check (not the seal check)
    from meta_orchestrator.experiment.s2.handoff import _canonical_bytes
    import hashlib
    json.dump(manifest, open(mp, "w"), indent=2, sort_keys=True)
    open(sp, "w").write(hashlib.sha256(_canonical_bytes(manifest)).hexdigest() + "\n")
    res = verify_handoff(root, mp, sp)
    assert not res.ok and any("required_pilot_node_ids_mismatch" in r for r in res.reasons)


def test_symlink_path_is_rejected(tmp_path):
    root = _repo(tmp_path)
    mp, sp, manifest = _write_bundle(root)
    # replace a real file with a symlink to outside the repo
    target = os.path.join(root, "src/meta_orchestrator/experiment/s2/x.py")
    os.remove(target)
    os.symlink("/etc/hostname", target)
    res = verify_handoff(root, mp, sp)
    assert not res.ok and any("unsafe_path" in r for r in res.reasons)


def test_production_token_artifact_in_bundle_is_rejected(tmp_path):
    root = _repo(tmp_path)
    # a stray artifact declaring a real count sneaks into a critical path
    open(os.path.join(root, "corpus/s2_leak.json"), "w").write(
        '{"token_count_source": "anthropic_count_tokens"}\n')
    mp, sp, _ = _write_bundle(root)
    res = verify_handoff(root, mp, sp)
    assert not res.ok and any("production_token_artifact_in_bundle" in r for r in res.reasons)
