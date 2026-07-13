# Phase-1 validation experiment (v2) — Pilot-0 harness

This is the **measurement apparatus** for the controlled learning experiment. It is
deliberately separate from the agent backbone (`src/meta_orchestrator/…`): the measured
agent runs through a *controlled runner* with a frozen contract, a sandbox with
repo-reset, and a fixed composite verifier the learning policy cannot touch.

> **Status: Pilot-0 (harness qualification) only.** No real model, no learning claims.
> Learning writes (promotion, playbook versions) are wired but OFF. The real experiment
> corpus (train/validation/locked-holdout) is sourced separately — v2 §12
> (generator ≠ solver, real bugs, locked holdout).

## v2 section → module

| v2 § | Module | What it enforces |
|---|---|---|
| §5 frozen contract | `experiment/contract.py` | provider / exact model id / config / prompt hash, snapshot-hashed per run |
| §5 controlled runner | `experiment/runner.py` | task → contract → tools → sandbox → verifier → event log |
| §6 sandbox + reset | `experiment/sandbox.py` | fresh temp dir per run; protected-path hashing; pytest |
| §6 composite verifier | `experiment/verifier.py` | public ∧ hidden ∧ protected-unchanged ∧ static ∧ scope ∧ no-shortcut |
| §5/§6 tool contract | `experiment/agent.py` | path-scoped tools; hidden tests unreachable; TaskView hides hidden tests |
| §7 lessons | `experiment/lesson.py` | structured schema + forbidden-content (leak/replay) validation |
| §9 two mocks | `experiment/mocks.py` | protocol (well-behaved) + adversarial (must be contained) |
| §10 storage | `experiment/store.py`, `experiment/artifacts.py` | append-only event log + projection; RunStore/LessonStore/PlaybookStore; content-addressed artifacts; migrations |

## Qualification criteria (Pilot-0)

Run `pytest tests/test_exp_*.py`. The harness is qualified when:

1. Sandbox resets between runs (no state leakage).
2. Hidden tests are unreachable by agent tools; a candidate can't read or edit them.
3. The verifier cannot be bypassed — hardcoded answers fail (`hidden` + `no_shortcut`),
   test tampering fails (`protected`), out-of-scope patches fail (`scope`).
4. The adversarial mock is fully contained on every attack; its leak/replay lesson is rejected.
5. The protocol mock runs clean and is reproducible; the event log projects run state.

## Not yet built (next, after corpus source is chosen)

Conditions A/B/C/D comparison harness, evidence-gated promotion, paired stats (McNemar),
ablation + negative-learning + negative-transfer, calibration (Pilot-1), real corpus.
