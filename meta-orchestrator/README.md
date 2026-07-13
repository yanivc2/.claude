# Learning Meta-Orchestrator — Phase 1 MVP

A learning meta-orchestrator: takes a task, picks the path that yields the best
result, executes, learns what worked from a **verified** success signal, stores it
compactly, and reuses that experience next time.

- **Source of truth:** [`SPEC.md`](./SPEC.md) (full v2 architecture, phased).
- **Execution engine:** [`BUILD-CHECKLIST.md`](./BUILD-CHECKLIST.md) — built Milestone by Milestone (A→B→C→D), pausing for review after each.
- **Seed task:** [`SEED_TASK.md`](./SEED_TASK.md) — code-fix verified by running tests (clean objective signal).

Phase 1 is deliberately lean (only the `[P1]` parts of the spec): taxonomy,
persistence + Registry with provenance, a verification+memory backbone, a single
Decision-Engine utility function, bandit learning, one single-agent LangGraph loop,
and an eval harness that proves the playbook improves across runs.

## Stack (Phase 1, confirmed with the user)

- **Python + LangGraph** orchestration engine.
- **SQLite behind a `Store` abstraction** — zero-setup, runnable/testable offline;
  a PostgreSQL implementation can drop in later without touching orchestration logic.
- **Model Gateway with a deterministic mock adapter** by default (offline tests);
  a real adapter loads via the Registry per env.

## Layout

```
src/meta_orchestrator/
├── models.py          shared domain types (taxonomy, registry, playbook, decision records)
├── taxonomy.py        minimal task taxonomy (SPEC §2) covering the seed task
├── config.py          config-driven model selection (names resolved via Registry)
├── bootstrap.py       composition root: connect DB + seed taxonomy/Registry
├── persistence/       Store abstraction + SQLite implementation (swappable backend)
├── registry/          Model Registry (SPEC §9): names + metadata + provenance
├── verification/      verify() layer (SPEC §5.4): pytest-backed code verifier
├── learning/          bandit/Bayesian updates (SPEC §6) + failure→update mapping (§5.6)
├── decision/          Decision/Utility Engine v1 (SPEC §4)
├── memory/            Tier-1 playbook write pipeline (gated) + compact read (§5)
└── seed_task/         seed task definition, success rule, and bug corpus
tests/                 pytest suite (offline, deterministic)
examples/boot.py       Milestone A demo
```

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q      # tests
.venv/bin/python examples/boot.py  # boot demo
```

## Progress

- [x] **Milestone A** — scaffold + persistence + schemas (Registry+provenance, Playbook, Decision Records, taxonomy)
- [x] **Milestone B** — learning backbone (verify(), failure taxonomy, bandit, memory-write, Decision Engine v1)
- [ ] **Milestone C** — single-agent LangGraph loop
- [ ] **Milestone D** — autonomy/circuit-breakers, tracing, eval harness (proves learning)
