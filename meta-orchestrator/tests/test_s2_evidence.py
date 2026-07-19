"""Evidence chain, hash-chained run log, call journal, budget reservation — the final $0 batch.

Pure/offline. Covers GPT's 12 mandatory adversarial cases: summary artifacts can't authorize;
missing required test rejected; wrong-run artifact rejected; historic edit / tail deletion / partial
line detected; env drift blocks; request-changed hash mismatch; proxy-copied-to-real fails; crash
after send → no retry; budget double-reservation → one wins.
"""
from __future__ import annotations

import os

import pytest

from meta_orchestrator.experiment.s2 import (AuthorizationAnchor, BudgetEvidence, BudgetLedger,
                                             CALL_AMBIGUOUS_AFTER_SEND, CALL_SENT, CountEvidence,
                                             CallJournal, EnvironmentAttestation, GateError,
                                             PreparedRequest, PytestEvidence, REAL_SOURCE, RunLog,
                                             SnapshotEvidence, TrainingEvidence,
                                             assert_sent_body_matches, attestation_matches,
                                             build_run_manifest, classify_journal_terminal,
                                             gate1_from_evidence, make_anchor,
                                             recompute_frozen_hashes_predicate, verify_anchor,
                                             verify_count_evidence, verify_pytest_evidence,
                                             verify_training_evidence)

RID = "run-1"
ENV = "env-abc"
REQUIRED = ["tests/test_s2_prepaid.py::test_sdk_serialized_body_omits_effort_and_temperature"]


def _pytest_ev(**over):
    base = dict(run_id=RID, environment_hash=ENV, git_commit="c", exit_code=0, failed=0, skipped=0,
                passed_node_ids=list(REQUIRED), sdk_version="0.40.0", httpx_version="0.27.0",
                command_hash="h")
    base.update(over)
    return PytestEvidence(**base).sealed()


# --- evidence: observations, not trusted summaries ---------------------------------------
def test_sdk_evidence_passes_on_real_observations():
    p = verify_pytest_evidence(_pytest_ev(), run_id=RID, environment_hash=ENV,
                               required_node_ids=REQUIRED)
    assert p.ok


def test_skipped_or_failed_is_rejected():
    assert not verify_pytest_evidence(_pytest_ev(skipped=1), run_id=RID, environment_hash=ENV,
                                      required_node_ids=REQUIRED).ok
    assert not verify_pytest_evidence(_pytest_ev(failed=1), run_id=RID, environment_hash=ENV,
                                      required_node_ids=REQUIRED).ok


def test_missing_required_test_is_rejected():
    ev = _pytest_ev(passed_node_ids=["tests/test_other.py::test_x"])   # required one didn't run
    assert not verify_pytest_evidence(ev, run_id=RID, environment_hash=ENV,
                                      required_node_ids=REQUIRED).ok


def test_wrong_run_or_env_artifact_is_rejected():
    assert not verify_pytest_evidence(_pytest_ev(), run_id="other", environment_hash=ENV,
                                      required_node_ids=REQUIRED).ok
    assert not verify_pytest_evidence(_pytest_ev(), run_id=RID, environment_hash="other",
                                      required_node_ids=REQUIRED).ok


def test_forged_summary_without_matching_observations_is_rejected():
    # hand-edit the observations after sealing → the self-hash no longer matches.
    ev = _pytest_ev()
    tampered = ev.model_copy(update={"failed": 0, "skipped": 0, "passed_node_ids": REQUIRED,
                                     "exit_code": 0, "sdk_version": "LIE"})
    assert not verify_pytest_evidence(tampered, run_id=RID, environment_hash=ENV,
                                      required_node_ids=REQUIRED).ok   # artifact_hash_mismatch


def test_proxy_count_is_rejected_and_real_passes():
    real = [CountEvidence(canonical_request_hash="r1", counter_source=REAL_SOURCE, model="m",
                          tokens=100, round_template="R1")]
    proxy = [CountEvidence(canonical_request_hash="r1", counter_source="offline_proxy", model="m",
                           tokens=100, round_template="R1")]
    assert verify_count_evidence(real, expected_request_hashes={"r1"}, model="m", context_cap=4096).ok
    assert not verify_count_evidence(proxy, expected_request_hashes={"r1"}, model="m",
                                     context_cap=4096).ok


def test_count_for_a_different_request_is_caught():
    obs = [CountEvidence(canonical_request_hash="rX", counter_source=REAL_SOURCE, model="m",
                         tokens=1, round_template="R1")]
    p = verify_count_evidence(obs, expected_request_hashes={"r1"}, model="m", context_cap=4096)
    assert not p.ok and any("missing_counts" in r for r in p.reasons)


def test_gate_recomputes_frozen_hashes():
    m = build_run_manifest(RID, "c", budget_usd=4.89, corpus_dir=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus"))
    assert recompute_frozen_hashes_predicate(m.hashes, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")).ok
    # a tampered manifest hash is caught
    m.hashes["verifier_config"] = "deadbeef"
    assert not recompute_frozen_hashes_predicate(m.hashes, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "corpus")).ok


def test_gate1_from_evidence_blocks_offline_and_authorizes_real():
    m = build_run_manifest(RID, "c", budget_usd=4.89)
    good_budget = BudgetEvidence(projected_fold_cost=2.0, reserve_fraction=0.25, available_budget=4.89)
    good_snap = SnapshotEvidence(model_id="m", available=True, retirement_date_iso="2026-10-15",
                                 as_of_date_iso="2026-07-19")
    real_count = [CountEvidence(canonical_request_hash="r1", counter_source=REAL_SOURCE, model="m",
                                tokens=100, round_template="R1")]
    # real inputs → passes
    r = gate1_from_evidence(manifest=m, corpus_dir=None, pytest_ev=_pytest_ev(),
                            environment_hash=ENV, required_node_ids=REQUIRED, count_obs=real_count,
                            expected_request_hashes={"r1"}, model="m", context_cap=4096,
                            budget_ev=good_budget, snapshot_ev=good_snap)
    assert r.passed and r.production_valid
    # proxy count → cannot be production-valid
    proxy_count = [CountEvidence(canonical_request_hash="r1", counter_source="offline_proxy",
                                 model="m", tokens=100, round_template="R1")]
    r2 = gate1_from_evidence(manifest=m, corpus_dir=None, pytest_ev=_pytest_ev(),
                             environment_hash=ENV, required_node_ids=REQUIRED, count_obs=proxy_count,
                             expected_request_hashes={"r1"}, model="m", context_cap=4096,
                             budget_ev=good_budget, snapshot_ev=good_snap)
    assert not r2.passed and not r2.production_valid


# --- hash-chained run log + authorization anchor -----------------------------------------
def _log(tmp):
    return RunLog(os.path.join(tmp, "runlog.jsonl"), RID)


def test_chain_appends_and_verifies(tmp_path):
    log = _log(str(tmp_path))
    log.append(new_state="AUTHORIZED_FOR_FOLD1_C_TRAINING", evidence_bundle_hash="e1", timestamp="t1")
    head, seq, state = log.head()
    assert seq == 0 and state == "AUTHORIZED_FOR_FOLD1_C_TRAINING"


def test_editing_a_record_breaks_the_chain(tmp_path):
    log = _log(str(tmp_path))
    log.append(new_state="AUTHORIZED_FOR_FOLD1_C_TRAINING", evidence_bundle_hash="e1", timestamp="t1")
    # tamper with the persisted line
    lines = open(log.path).read().splitlines()
    lines[0] = lines[0].replace("AUTHORIZED_FOR_FOLD1_C_TRAINING", "BLOCKED")
    open(log.path, "w").write("\n".join(lines) + "\n")
    with pytest.raises(GateError):
        log.load()


def test_tail_deletion_is_caught_by_anchor(tmp_path):
    log = _log(str(tmp_path))
    log.append(new_state="AUTHORIZED_FOR_FOLD1_C_TRAINING", evidence_bundle_hash="e1", timestamp="t1")
    log.append(new_state="GATE2_PASSED_FOLD1", evidence_bundle_hash="e2", timestamp="t2")
    anchor = make_anchor(log, authorized_state="GATE2_PASSED_FOLD1", evidence_bundle_hash="e2")
    verify_anchor(log, anchor)                        # matches now (seq 1, GATE2)
    # delete the tail (simulate restoring the older single-row file)
    first_line = open(log.path).read().splitlines()[0]
    open(log.path, "w").write(first_line + "\n")
    # the live head is now seq 0 / AUTHORIZED — it no longer matches the GATE2 anchor.
    with pytest.raises(GateError):
        verify_anchor(log, anchor)


def test_partial_last_line_is_blocked(tmp_path):
    log = _log(str(tmp_path))
    log.append(new_state="AUTHORIZED_FOR_FOLD1_C_TRAINING", evidence_bundle_hash="e1", timestamp="t1")
    with open(log.path, "a") as f:
        f.write('{"partial": ')                       # crash mid-write, no newline
    with pytest.raises(GateError):
        log.load()


# --- environment re-attestation ----------------------------------------------------------
def _att(**over):
    base = dict(git_commit="c", worktree_clean=True, python_version="3.11.0", sdk_version="0.40.0",
                httpx_version="0.27.0", lockfile_hash="lh", endpoint="https://api.anthropic.com",
                contract_hash="ch", canonical_builder_hash="bh", verifier_hash="vh",
                required_env_vars_present={"META_ORCH_API_KEY": True})
    base.update(over)
    return EnvironmentAttestation(**base)


def test_env_drift_and_dirty_tree_block():
    base = _att()
    assert attestation_matches(base, _att()).ok
    assert not attestation_matches(base, _att(worktree_clean=False)).ok       # dirty tree
    assert not attestation_matches(base, _att(sdk_version="0.41.0")).ok        # package change
    assert not attestation_matches(base, _att(contract_hash="other")).ok       # contract change


# --- single immutable request (TOCTOU) ---------------------------------------------------
def test_request_changed_after_guard_is_blocked():
    prep = PreparedRequest(call_id="c1", fold=1, condition="C", round_index=1,
                           canonical_request_hash="sem", outbound_body_hash="BODY-A")
    assert_sent_body_matches(prep, "BODY-A")          # ok
    with pytest.raises(GateError):
        assert_sent_body_matches(prep, "BODY-B")      # a different body was sent


# --- call journal: crash after send → no silent retry ------------------------------------
def test_ambiguous_after_send_is_stop_not_retry(tmp_path):
    j = CallJournal(os.path.join(str(tmp_path), "journal.jsonl"))
    j.record("c1", CALL_SENT)
    j.record("c1", CALL_AMBIGUOUS_AFTER_SEND)
    assert classify_journal_terminal(j.states_for("c1")) == "ambiguous_stop"


# --- atomic budget reservation: two reservations, one wins -------------------------------
def test_budget_double_reservation_only_one_wins(tmp_path):
    ledger = BudgetLedger(os.path.join(str(tmp_path), "budget.json"), total_budget=1.0)
    ledger.reserve("c1", 0.8)
    with pytest.raises(GateError):
        ledger.reserve("c2", 0.8)                     # only 0.2 left → refused
    assert abs(ledger.available() - 0.2) < 1e-9


def test_reservation_reconciles_actual_cost(tmp_path):
    ledger = BudgetLedger(os.path.join(str(tmp_path), "budget.json"), total_budget=1.0)
    ledger.reserve("c1", 0.5)
    ledger.reconcile("c1", 0.12)
    assert abs(ledger.available() - (1.0 - 0.12)) < 1e-9


def test_training_evidence_blocks_incomplete():
    ev = TrainingEvidence(fold=1, outcomes={"t1": "solver_pass", "t2": "incomplete"},
                          expected_train_ids=["t1", "t2"])
    assert not verify_training_evidence(ev).ok
