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
  a **real Anthropic adapter** (`claude-opus-4-8` / `claude-haiku-4-5`) loads via the
  Registry when selected — see "Going live" below.

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
├── gateway/           Model Gateway + deterministic mock adapter (SPEC §9)
├── tools/             Tool Gateway with permission tiers (SPEC §11)
├── planner/           Planner: task decomposition into a task graph (SPEC §12)
├── autonomy/          Budget ledger + autonomy modes / circuit breaker (SPEC §10)
├── observability/     Correlation-ID trace + run metrics (SPEC §15)
├── evaluation/        Eval harness that proves learning across runs (SPEC §15)
├── postmortem.py      Predicted-vs-actual reflection → memory update (SPEC §5.7)
├── orchestrator/      The single-agent LangGraph loop (SPEC §1)
└── seed_task/         seed task definition, success rule, and bug corpus
tests/                 pytest suite (offline, deterministic)
examples/boot.py       Milestone A demo
```

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q          # tests (60, offline)
.venv/bin/python examples/boot.py      # A: boot + config-driven model choice
.venv/bin/python examples/backbone.py  # B: verify→bandit→decision→memory
.venv/bin/python examples/agent_run.py # C: full LangGraph agent loop
.venv/bin/python examples/eval_run.py  # D: prove learning across runs
```

## Going live (real Claude models)

The default adapter is the offline mock. To run against real Claude models
(`claude-opus-4-8` / `claude-haiku-4-5`, resolved via config → Registry — no model
name is hardcoded in the loop):

```bash
.venv/bin/pip install -e ".[real]"     # installs the anthropic SDK
export ANTHROPIC_API_KEY=...           # or: ant auth login
.venv/bin/python examples/real_run.py [bug_id]
# or set the adapter for any entry point:  META_ORCH_ADAPTER=anthropic
```

The real adapter (`gateway/adapters.py`) prompts the model to repair the module,
extracts the corrected source, and the **same pytest verifier** grades it — so the
verified success signal, bandit learning, and playbook are identical to the mock path.
The adapter's client is dependency-injected, so its request-building and response-parsing
are covered by offline tests without a network call or API key.

## Progress — Phase 1 complete

- [x] **Milestone A** — scaffold + persistence + schemas (Registry+provenance, Playbook, Decision Records, taxonomy)
- [x] **Milestone B** — learning backbone (verify(), failure taxonomy, bandit, memory-write, Decision Engine v1)
- [x] **Milestone C** — single-agent LangGraph loop (planner, tool tiers, synthesizer, independent verifier, post-mortem)
- [x] **Milestone D** — autonomy modes + circuit breakers, correlation-ID tracing/metrics, eval harness

**Phase 1 success criterion proven (D3):** starting from a *misleading* prior, the system
corrects it from verified outcomes — first choice converges to the strong model, retry
rounds drop (1.5→1.0), and playbook confidence grows (0.5→0.95). `PHASE1_PASS=True`.

Out of scope by design (later phases per SPEC §14): multi-model ensemble, exploration (ε),
cold-start panels, adaptive escalation, the innovation-update loop.
