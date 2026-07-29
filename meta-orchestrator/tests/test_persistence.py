"""A3: schemas exist and one row can be written/read in every table."""
from __future__ import annotations

from meta_orchestrator.models import (
    DecisionRecord,
    EvalScore,
    ModelSpec,
    PlaybookEntry,
    TaxonomyNode,
)
from meta_orchestrator.persistence.sqlite_store import SqliteStore


def fresh_store() -> SqliteStore:
    store = SqliteStore(":memory:")
    store.connect()
    store.init_schema()
    return store


def test_models_and_provenance_roundtrip():
    store = fresh_store()
    spec = ModelSpec(
        model_id="m1",
        provider="mock",
        capabilities=["code"],
        eval_scores=[EvalScore(task_type="Software:Debug", score=0.7, n_samples=3,
                               date="2026-07-13", source="unit-test")],
    )
    store.upsert_model(spec)
    got = store.get_model("m1")
    assert got is not None
    assert got.model_id == "m1"
    assert got.capabilities == ["code"]
    # provenance survived the round-trip
    assert len(got.eval_scores) == 1
    assert got.eval_scores[0].source == "unit-test"
    assert got.eval_scores[0].n_samples == 3
    store.close()


def test_playbook_roundtrip_with_versioning_fields():
    store = fresh_store()
    entry = PlaybookEntry(key="Software:Debug|risk:low|verifiable:yes",
                          content={"best_model": "m1"}, confidence=0.6, version=2)
    store.upsert_playbook(entry)
    got = store.get_playbook("Software:Debug|risk:low|verifiable:yes")
    assert got is not None
    assert got.content == {"best_model": "m1"}
    assert got.confidence == 0.6
    assert got.version == 2
    assert got.updated_at is not None  # stamped on write
    store.close()


def test_decision_record_roundtrip():
    store = fresh_store()
    rec = DecisionRecord(run_id="run-1", node="select_model", chosen="m1", utility=0.83,
                         alternatives=[{"label": "m2", "utility": 0.4}], reason="highest utility")
    store.add_decision_record(rec)
    got = store.list_decision_records("run-1")
    assert len(got) == 1
    assert got[0].chosen == "m1"
    assert got[0].alternatives[0]["label"] == "m2"
    store.close()


def test_taxonomy_roundtrip():
    store = fresh_store()
    store.upsert_taxonomy(TaxonomyNode(label="Software:Debug", parent="Software",
                                       kind="category", description="seed"))
    got = store.get_taxonomy("Software:Debug")
    assert got is not None
    assert got.parent == "Software"
    store.close()


def test_upsert_is_idempotent():
    store = fresh_store()
    store.upsert_model(ModelSpec(model_id="m1", provider="mock"))
    store.upsert_model(ModelSpec(model_id="m1", provider="mock2"))
    assert store.get_model("m1").provider == "mock2"
    assert len(store.list_models()) == 1
    store.close()
