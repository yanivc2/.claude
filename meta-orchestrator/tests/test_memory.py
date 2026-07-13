"""B4 + B5: memory-write pipeline (gated) and compact Tier-1 read."""
from __future__ import annotations

from meta_orchestrator.learning.bandit import BanditBook
from meta_orchestrator.memory.reader import PlaybookReader
from meta_orchestrator.memory.writer import MemoryWriter
from meta_orchestrator.models import FailureCategory, VerifyResult
from meta_orchestrator.taxonomy import SEED_TASK_TYPE, classify_seed_task

PASS = VerifyResult(passed=True, confidence=1.0, evidence=["2 passed"])
FAIL = VerifyResult(passed=False, confidence=1.0, evidence=["1 failed"],
                    failure_category=FailureCategory.TESTS_FAILED)


def test_verified_success_is_written(booted):
    store, _registry, _config = booted
    bandit = BanditBook(store)
    bandit.update(SEED_TASK_TYPE, "mock-strong", success=True, prior_score=0.8)
    writer = MemoryWriter(store)
    entry = writer.write(classification=classify_seed_task(), chosen_model="mock-strong",
                         verify_result=PASS, bandit=bandit, cost=0.02)
    assert entry is not None
    assert entry.content["best_model"] == "mock-strong"
    assert entry.confidence > 0
    assert entry.expiry is not None


def test_unverified_lesson_is_rejected(booted):
    store, _registry, _config = booted
    writer = MemoryWriter(store)
    entry = writer.write(classification=classify_seed_task(), chosen_model="mock-weak",
                         verify_result=FAIL, bandit=BanditBook(store))
    assert entry is None
    assert store.get_playbook(classify_seed_task().playbook_key()) is None


def test_confirm_false_blocks_write(booted):
    store, _registry, _config = booted
    writer = MemoryWriter(store)
    entry = writer.write(classification=classify_seed_task(), chosen_model="mock-strong",
                         verify_result=PASS, bandit=BanditBook(store),
                         confirm=lambda lesson: False)
    assert entry is None


def test_confidence_grows_with_repeated_confirmations(booted):
    store, _registry, _config = booted
    bandit = BanditBook(store)
    writer = MemoryWriter(store)
    c = classify_seed_task()
    e1 = writer.write(classification=c, chosen_model="mock-strong", verify_result=PASS, bandit=bandit)
    e2 = writer.write(classification=c, chosen_model="mock-strong", verify_result=PASS, bandit=bandit)
    assert e2.confidence > e1.confidence          # §5.5: repeats strengthen confidence
    assert e2.version == e1.version + 1           # versioning (§5.9)
    assert e2.content["verified_successes"] == 2


def test_reader_returns_compact_record(booted):
    store, _registry, _config = booted
    bandit = BanditBook(store)
    bandit.update(SEED_TASK_TYPE, "mock-strong", success=True, prior_score=0.8)
    MemoryWriter(store).write(classification=classify_seed_task(), chosen_model="mock-strong",
                              verify_result=PASS, bandit=bandit)
    reader = PlaybookReader(store)
    t1 = reader.read_tier1(classify_seed_task().playbook_key())
    assert t1["best_model"] == "mock-strong"
    assert "success_rate_by_model" in t1
    line = reader.render(classify_seed_task().playbook_key())
    assert line.startswith("[playbook:")
    assert len(line) < 200  # compact / few tokens
