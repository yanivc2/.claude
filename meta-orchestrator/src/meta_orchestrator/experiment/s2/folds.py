"""Deterministic k-fold *stratified* cross-validation split (Decision A).

27 tasks → k folds, stratified by semantic family so families are balanced across folds.
Every task is held-out (test) in exactly one fold; its train set is the complement. The
split is a pure function of the family map — no RNG, no clock — so the same corpus always
yields the same folds (reproducible, auditable). Fold N's condition-C bank is learned only
from fold N's train ids.
"""
from __future__ import annotations

from collections import defaultdict

from pydantic import BaseModel


class Fold(BaseModel):
    index: int
    train_ids: list[str]
    test_ids: list[str]


class FoldError(ValueError):
    """The requested split is impossible (e.g. k > #tasks, or a broken partition)."""


def stratified_folds(family_map: dict[str, str], k: int = 3) -> list[Fold]:
    """Partition the tasks into k stratified folds (test = held-out, train = complement)."""
    if k < 2:
        raise FoldError(f"k must be >= 2, got {k}")
    if len(family_map) < k:
        raise FoldError(f"cannot make {k} folds from {len(family_map)} tasks")

    by_family: dict[str, list[str]] = defaultdict(list)
    for tid in sorted(family_map):                      # sorted → deterministic
        by_family[family_map[tid]].append(tid)

    # A CONTINUOUS cursor across families: each family's tasks still spread over the buckets
    # (consecutive tasks → consecutive buckets), but the per-family remainders don't all pile
    # on fold 0 — so fold SIZES stay balanced (27 → 9/9/9) while strata stay balanced too.
    test_buckets: list[list[str]] = [[] for _ in range(k)]
    cursor = 0
    for family in sorted(by_family):
        for tid in by_family[family]:
            test_buckets[cursor % k].append(tid)
            cursor += 1

    all_ids = sorted(family_map)
    folds: list[Fold] = []
    for i in range(k):
        test = sorted(test_buckets[i])
        test_set = set(test)
        train = [t for t in all_ids if t not in test_set]
        folds.append(Fold(index=i, train_ids=train, test_ids=test))
    validate_folds(folds, all_ids)
    return folds


def validate_folds(folds: list[Fold], all_ids: list[str]) -> None:
    """Assert the partition is clean: disjoint train/test per fold, every id held-out once."""
    universe = set(all_ids)
    seen_as_test: list[str] = []
    for f in folds:
        if set(f.train_ids) & set(f.test_ids):
            raise FoldError(f"fold {f.index}: train and test overlap")
        if set(f.train_ids) | set(f.test_ids) != universe:
            raise FoldError(f"fold {f.index}: train ∪ test != corpus")
        seen_as_test.extend(f.test_ids)
    if sorted(seen_as_test) != sorted(all_ids):
        raise FoldError("every task must be held-out in exactly one fold")
