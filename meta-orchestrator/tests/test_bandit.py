"""B3: Bayesian/bandit update is gradual and correct; persists across reloads."""
from __future__ import annotations

from meta_orchestrator.learning.bandit import BanditBook
from meta_orchestrator.persistence.sqlite_store import SqliteStore

TT = "Software:Debug"


def fresh() -> SqliteStore:
    s = SqliteStore(":memory:")
    s.connect()
    s.init_schema()
    return s


def test_prior_sits_between_half_and_seed_score():
    book = BanditBook(fresh())
    # seed prior 0.8 → mean pulled toward it but weak (not exactly 0.8, not 0.5)
    m = book.estimate(TT, "mock-strong", prior_score=0.8)
    assert 0.5 < m < 0.8


def test_single_win_moves_a_little_not_to_one():
    store = fresh()
    book = BanditBook(store)
    before = book.estimate(TT, "m", prior_score=0.5)  # 0.5
    after = book.update(TT, "m", success=True).mean
    assert after > before
    assert after < 0.75  # a single win does NOT jump to ~1.0


def test_five_runs_update_gradually_and_correctly():
    store = fresh()
    book = BanditBook(store)
    means = [book.estimate(TT, "m", prior_score=0.5)]
    for _ in range(5):
        means.append(book.update(TT, "m", success=True).mean)
    # monotonic increase, bounded below 1, and n_samples tracked
    assert all(b > a for a, b in zip(means, means[1:]))
    assert means[-1] < 1.0
    stat = store.get_bandit_stat(TT, "m")
    assert stat.successes == 5 and stat.failures == 0


def test_failures_pull_estimate_down_and_persist():
    store = fresh()
    book = BanditBook(store)
    for _ in range(4):
        book.update(TT, "m", success=False)
    assert book.estimate(TT, "m") < 0.5
    # reload from store → state persisted
    book2 = BanditBook(store)
    assert book2.estimate(TT, "m") < 0.5
    assert store.get_bandit_stat(TT, "m").failures == 4


def test_converges_toward_empirical_rate():
    store = fresh()
    book = BanditBook(store)
    # 7 wins / 3 losses ~ 0.7 empirical; weak prior at 0.5 → estimate should exceed 0.5
    for i in range(10):
        book.update(TT, "m", success=(i % 10) < 7, prior_score=0.5)
    assert book.estimate(TT, "m") > 0.55
