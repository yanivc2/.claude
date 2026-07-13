"""Bayesian bandit over verified success rate per (task_type, model) — SPEC §6, B3.

Beta-Binomial: a single win nudges the estimate, it does not jump to 100%. The prior
is seeded (weakly) from the Registry's provenance eval score so cold-start is sane,
then observed verified outcomes dominate. Selection uses the posterior *mean*;
Thompson sampling (exploration) is provided but unused — that is Phase 3 (SPEC §6).
"""
from __future__ import annotations

import random
from typing import Optional

from ..models import BanditStat
from ..persistence.store import Store


class BanditBook:
    def __init__(self, store: Store, prior_strength: float = 4.0, prior_floor: float = 0.5) -> None:
        # prior_strength = pseudo-count weight of the seeded prior. Deliberately small
        # so a handful of real outcomes outweigh it (SPEC §6: "win moves it a little").
        self._store = store
        self._k = prior_strength
        self._floor = prior_floor

    def _prior_ab(self, prior_score: Optional[float]) -> tuple[float, float]:
        score = 0.5 if prior_score is None else max(0.0, min(1.0, prior_score))
        alpha0 = self._floor + self._k * score
        beta0 = self._floor + self._k * (1.0 - score)
        return alpha0, beta0

    def get_or_init(self, task_type: str, model_id: str, prior_score: Optional[float] = None) -> BanditStat:
        stat = self._store.get_bandit_stat(task_type, model_id)
        if stat is not None:
            return stat
        alpha0, beta0 = self._prior_ab(prior_score)
        stat = BanditStat(task_type=task_type, model_id=model_id, alpha=alpha0, beta=beta0)
        self._store.upsert_bandit_stat(stat)
        return stat

    def update(self, task_type: str, model_id: str, success: bool,
               prior_score: Optional[float] = None) -> BanditStat:
        stat = self.get_or_init(task_type, model_id, prior_score)
        if success:
            stat.alpha += 1.0
            stat.successes += 1
        else:
            stat.beta += 1.0
            stat.failures += 1
        self._store.upsert_bandit_stat(stat)
        return stat

    def estimate(self, task_type: str, model_id: str, prior_score: Optional[float] = None) -> float:
        """Posterior mean success rate (used by the Decision Engine)."""
        return self.get_or_init(task_type, model_id, prior_score).mean

    def sample(self, task_type: str, model_id: str, rng: random.Random,
               prior_score: Optional[float] = None) -> float:
        """Thompson sample from the posterior. Reserved for Phase 3 exploration."""
        stat = self.get_or_init(task_type, model_id, prior_score)
        return rng.betavariate(stat.alpha, stat.beta)
