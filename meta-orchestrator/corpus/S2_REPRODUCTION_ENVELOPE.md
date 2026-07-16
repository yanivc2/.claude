# §2 Reproduction Operational Envelope (FROZEN 2026-07-16)

Frozen BEFORE any real reproduction run, so the wiring can't be tuned per-bug to "look valid".

## Repo-backed ExperimentTask (`experiment/s2/repro.py :: RepoBackedTask`)

A real task is repo-backed (its tests need the installed package), unlike the offline tiny-file
`ExperimentTask`. Fields:

- `task_id, project, family, repo_url`
- `buggy_rev, fixed_rev` — pinned commits (fixed's parent = buggy).
- `allowed_source_files` — the frozen scope set (amendment A). The agent may write ONLY these.
- `repair_scope` — `single_file | multi_file`.
- `buggy_source` — allowed files @ buggy (what the agent starts from).
- `reference_fix` — allowed files @ fixed. **EVALUATOR-ONLY**; never shown to the agent.
- `f2p_plan` — HIDDEN tests (`[[test_file, keyword|None], …]`), used only by the verifier.
- `p2p_nodes` — PUBLIC tests (pass on both revisions), visible to the agent.
- `sanitized_statement` — issue text, sanitized + leak-scanned; never the raw/fixed-commit text.

The committed manifest (`corpus/s2_real_corpus.json`) stores a LEAN view — revs, allowed files +
content **hashes**, F2P plan, P2P count, sanitized statement, status/gates. Full source is
re-materialised from the pinned revisions at grading time (git is the source of truth).

## Timeout policy (seconds)

`clone 600 · venv 300 · pip 600 · install 600 · pytest 300`. Any timeout → **harness failure**
(never a repair failure).

## Dependency isolation / cache

One clone per project, one venv per project (`<repo>/.venv`), reused across that project's bugs by
checking out different revisions. `pip install -e .` per revision. No global installs; no shared
interpreter state across projects.

## Reproduction status codes (mutually exclusive)

- `reproduced` — passed all 8 gates.
- `non_reproducible` — F2P selectable but the bug/tests don't behave stably (or no F2P test found).
- `harness_dependency_failure` — clone/venv/install/timeout/scope-mismatch/unreadable file.
- `invalid_f2p` — no test fails-on-buggy AND passes-on-fixed.
- `invalid_p2p` — no public (pass-on-both) test found.
- `leakage_rejected` — sanitized statement still leaks (hidden-test name, fix commit, patch hint,
  allowed-file path) or is too vague to be a fair task.

## The 8-point gate (all required for `reproduced`)

1. deterministic checkout of buggy and fixed.
2. `allowed_source_files` equals the reference patch's source files exactly (frozen scope).
3. reference fix is built ONLY from the diff in the allowed files.
4. F2P fails on buggy AND passes on fixed.
5. P2P passes on fixed (and, where present, on buggy).
6. statement carries no patch hints, hidden-test names, or fixed-commit information.
7. a clean re-run gives the same result (stable across the two runs of each revision).
8. install/timeout failures are classified as harness failures, not repair failures.

## No manual fallback (binding)

No per-bug special-casing that changes a task's content. Pipeline fixes must be **general**; every
general fix triggers a **re-run of all tasks**, including ones that already passed (delete
`s2_real_corpus.json` to force it). manifest / family map / folds / D / scope metadata are never
edited to make a bug pass.

## Final report strata (separate, never merged)

`reproduced` · `non_reproducible` · `harness_dependency_failure` · `invalid_f2p` · `invalid_p2p`
· `leakage_rejected`. A systematic extraction/checkout/F2P-classification error can make an
invalid corpus look valid, so these are reported and inspected before the corpus is declared
ready for the micro-pilot.
