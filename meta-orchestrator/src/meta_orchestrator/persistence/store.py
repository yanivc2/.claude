"""Abstract persistence interface (SPEC §16.8: swappable state backend).

Any backend (SQLite for Phase 1, PostgreSQL later) implements this. Orchestration
code depends only on this interface, never on a concrete DB.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from ..models import (
    BanditStat,
    DecisionRecord,
    EvalScore,
    ModelSpec,
    PlaybookEntry,
    TaxonomyNode,
)


class Store(ABC):
    # --- lifecycle ---
    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def close(self) -> None: ...

    @abstractmethod
    def init_schema(self) -> None:
        """Create all tables if absent (idempotent)."""

    # --- Registry (models + provenance eval scores) — SPEC §9 ---
    @abstractmethod
    def upsert_model(self, spec: ModelSpec) -> None: ...

    @abstractmethod
    def get_model(self, model_id: str) -> Optional[ModelSpec]: ...

    @abstractmethod
    def list_models(self) -> list[ModelSpec]: ...

    @abstractmethod
    def add_eval_score(self, model_id: str, score: EvalScore) -> None: ...

    # --- Playbook (Tier-1 memory) — SPEC §5.1, §5.9 ---
    @abstractmethod
    def upsert_playbook(self, entry: PlaybookEntry) -> None: ...

    @abstractmethod
    def get_playbook(self, key: str) -> Optional[PlaybookEntry]: ...

    @abstractmethod
    def list_playbooks(self) -> list[PlaybookEntry]: ...

    # --- Decision Records — SPEC §5.8 ---
    @abstractmethod
    def add_decision_record(self, record: DecisionRecord) -> None: ...

    @abstractmethod
    def list_decision_records(self, run_id: Optional[str] = None) -> list[DecisionRecord]: ...

    # --- Taxonomy — SPEC §2 ---
    @abstractmethod
    def upsert_taxonomy(self, node: TaxonomyNode) -> None: ...

    @abstractmethod
    def get_taxonomy(self, label: str) -> Optional[TaxonomyNode]: ...

    @abstractmethod
    def list_taxonomy(self) -> list[TaxonomyNode]: ...

    # --- Bandit stats (SPEC §6) ---
    @abstractmethod
    def upsert_bandit_stat(self, stat: BanditStat) -> None: ...

    @abstractmethod
    def get_bandit_stat(self, task_type: str, model_id: str) -> Optional[BanditStat]: ...

    @abstractmethod
    def list_bandit_stats(self, task_type: Optional[str] = None) -> list[BanditStat]: ...

    # --- context-manager sugar ---
    def __enter__(self) -> "Store":
        self.connect()
        self.init_schema()
        return self

    def __exit__(self, *exc) -> None:
        self.close()
