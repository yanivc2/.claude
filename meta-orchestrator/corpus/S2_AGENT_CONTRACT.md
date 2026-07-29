# §2 Agent Contract & Micro-Pilot Plan (FROZEN 2026-07-16)

Frozen BEFORE the first paid API call. The contract is chosen for experimental validity, not
for the $4.89 credit — the budget may stop a run, it may not distort the agent definition.
Bound to: corpus manifest `cee0c602`, family map `4171f399`, D `5bd2d42c`, scope `79fae38b`,
verifier `6gate-v1`, real corpus `s2_real_corpus.json` (27/27 reproduced).

---

## Decision A — the frozen agent contract (identical across A / C / D / B1)

| Parameter | Frozen value |
|---|---|
| provider / model | `anthropic` / `claude-haiku-4-5-20251001` (exact snapshot, no alias) |
| `thinking` | `{"type": "enabled", "budget_tokens": 1024}` |
| `max_tokens` (per model call) | `4096` |
| `output_config.effort` | **NOT SENT** (errors on Haiku 4.5) |
| `temperature` / `top_p` / `top_k` | **NOT SENT** (incompatible with extended thinking; omit) |
| context | all target file(s), with a cap fixed in preflight (below) |
| fallback | **off** (`experiment_mode` → `ModelUnavailableError`, no silent fallback) |
| hidden (F2P) tests | never in the prompt; verifier-only |

**Why `budget_tokens=1024` (verified against the claude-api catalog):** Haiku 4.5 is a
pre-4.6 model — it uses `thinking:{type:"enabled", budget_tokens:N}`, NOT adaptive thinking
(adaptive → 400). Minimum budget is 1024 and it must be `< max_tokens`. The tasks are small,
file-given, single-file/near-single-file, and the budget is tight, so start at the 1024 floor;
raising it is a *result* of the micro-pilot, never a mid-run change (bump the experiment
version and restart).

**Context cap (preflight, $0 via `count_tokens`):** before any paid run, count the full input
for all 27 tasks × 4 conditions, take the max, and freeze
`context_cap = round_up(max_observed_input_tokens + 2048 headroom)`. 64K is a sane ceiling only
if all 27 fit without truncation (Haiku 4.5: 200K context / 64K max output). If a task exceeds
the cap it is pre-excluded OR one deterministic truncation is applied identically to all
conditions — never a manual region. `count_tokens` is model-specific and an estimate (not
byte-identical to billing).

**Must be frozen in A:** exact snapshot; `budget_tokens`; `max_tokens`; the omission of
temperature/top_p/top_k **and** effort; tool schemas + tool order; system-prompt + agent-prompt
hashes; context cap + truncation policy; stop conditions; cache policy; timeout + retry policy;
circuit breakers.

---

## Decision B — what an "attempt" is (agentic, bounded)

An attempt is a **session** for one task under one condition — not a single API call. Bounded:
**≤2 model calls, ≤2 patch submissions, ≤2 public-test runs, 1 final hidden verification.**

Flow — **Round 1:** the agent gets the sanitized statement, the target file(s), and the
condition's memory component → emits patch 1 → harness applies it → `run_public_tests` runs
automatically. If public passes → **stop** (no gratuitous extra round). If public fails → the
agent gets length-limited, sanitized public output and one repair round. **Round 2:** patch 2 →
public tests → session ends regardless of result. **Then:** the hidden verifier runs once; the
agent gets **no** F2P feedback.

**The ceiling and stop rule are identical across conditions; the number of rounds actually used
is not** — if A stops after one round and C needs two, that is a *result* (efficiency, cost,
#repairs, playbook use). Forcing everyone to two rounds adds artificial noise and cost.

**Must be frozen in B:** the attempt definition; when Round 2 opens; which slice of test output
is passed back + its length cap; behavior on an invalid patch; whether a transient API retry is
allowed and how it's counted; hidden verifier once, no feedback.

---

## Decision C — C's learning mechanism

**Principle: the model PROPOSES a lesson; deterministic code DECIDES whether it is written.**
The model is never proposer + judge + promoter.

**Candidate extraction (no extra LLM call):** on each C *train* task, the agent's final output
includes, alongside the patch, a structured candidate `{recommended_action: [...], avoid: [...]}`.
A separate per-train extraction call would add up to 54 calls and likely break the budget.
The candidate may derive ONLY from: the given problem, the accessible code, the agent's actions,
public-test feedback, and the agent's own patch. NOT from: hidden-test contents, the reference
patch, summarized thinking, or verifier internals beyond PASS/FAIL.

**Write-gate (deterministic; all must hold):** (1) task is train; (2) final verifier PASS;
(3) schema-valid; (4) no paths / line numbers / unique literals / task IDs / patch replay
(reuses `validate_lesson` + the D leak scan); (5) no duplicate/contradiction with an existing
lesson; (6) family from the frozen taxonomy, never the model; (7) slot budget not exceeded;
(8) candidate selection is a deterministic ranking.

**Learn from successes vs failures:** `recommended_action` may be promoted after **one**
objective success (the experiment tests one-shot procedural transfer) — but confidence starts
low, ≤1 candidate per source task, more support raises confidence, later contradiction lowers
or deprecates. `avoid` is NOT promoted from a single final failure; an active `avoid` is written
only when (a) Round 1 failed public, Round 2 changed approach and PASSED the verifier (in-task
contrast), or (b) the same failing pattern appears in ≥2 distinct train tasks with positive
evidence for an alternative. Failure without a contrasting success stays in the episodic log,
not the active playbook.

**Format parity with D (mandatory):** C and D share `recommended_action` + `avoid`, the same
renderer, the same char cap, ≤8 rendered lines, the same prompt position + ordering, and
`max_active_entries_per_family = 2` (tie-break by frozen score, then `source_task_id`). Only the
CONTENT differs.

**Must be frozen in C:** candidate schema; extractor format; promotion/deprecation rules;
evidence thresholds; contradiction handling; dedup; ranking + tie-break; entries per family;
renderer + slot budget; the no-write-in-held-out rule; the ban on using hidden evidence beyond
PASS/FAIL for the gate.

---

## Decision D — micro-pilot structure + circuit breakers

Reps for the pilot (fold 1, 9 held-out): **A reps=2, C reps=2** (against the same frozen bank),
**B1 reps=1, D reps=1.** A and C are the two central axes (baseline + learned treatment); this
suffices for a directional stability gate. **Documented limit:** B1 and D stability is not
independently assessed in the pilot; comparisons against them are single-rep and need
replication before a strong claim. No budget justification to double all four now; a confirmatory
study gives all conditions equal reps.

**Cost model (real, not just estimate).** Fold 1 = 18 (C learn) + 36 (A/B1/C/D eval over 9) + 18
(A/C second rep) = **72 task-condition sessions**. At ~$0.025/first-call ≈ **$1.80** base; a
session may fire a second model call, so
`micro_cost = 72·cost_first + n_repairs·cost_second`. At ~20% Round-2 rate ≈ +$0.35 →
**~$1.80–$2.20**. Haiku billing is $1/$5 per 1M in/out and **thinking counts as billed output**,
so record actual thinking usage + output length on every call.

**Circuit breakers:** `MICRO_PILOT_HARD_CAP = $2.25`, `GLOBAL_EXPERIMENT_HARD_CAP = $4.65`. Stop
before every new fold. After fold 1 compute mean and P75 cost/session; continue only if
`spent + 1.15·observed_mean_cost_per_session·remaining_sessions ≤ $4.65` (15% safety margin).

**Budget tension (honest):** full 3-fold reps=1 ≈ 180 sessions ≈ $4.50 leaves almost no room for
repair calls — `max_rounds=2` and $4.89 are in real tension. If the pilot shows non-trivial
Round-2 use, the only valid moves are: (1) raise the budget, (2) stop after fold 1 and label it
exploratory, or (3) open a NEW experiment version with `max_rounds=1`. **Never** switch to
`max_rounds=1` mid-way and continue folds 2–3 — the folds would no longer be comparable.

---

## Decision E — remaining validity risks + mitigations

1. **Contamination** (Haiku snapshot 2025-10-01; public Black code + bugs). Mitigate: network
   off; `.git`/fix history inaccessible; reference patch outside the sandbox; issue/commit IDs
   stripped; statements sanitized; patch-similarity computed only AFTER the run; record each
   task's fix date. Report: split tasks pre/post training cutoff; pre-declare contamination flags
   (patch identical to reference; very high normalized edit similarity; use of text/comments not
   in the input). Never auto-drop a task after seeing its result — report all tasks + a
   sensitivity analysis excluding flagged ones. High similarity is a signal, not proof (some bugs
   have one natural fix).
2. **Small n / within-fold dependence.** 9 tasks/fold share one C bank → 27 outcomes are not
   fully independent. Report: full paired table; per-fold; per-family descriptive only at small n;
   C-pass/A-fail and A-pass/C-fail counts; exact McNemar when shared-pair count is small; effect
   size, not just p. Stays a **directional pilot** even with a positive p-value.
3. **Snapshot dependence.** Conclusion is valid for `claude-haiku-4-5-20251001` + frozen prompt +
   frozen thinking budget + frozen tool contract only — not another model, alias, budget, or
   provider. Record per run: requested + returned model id, API/SDK version, endpoint/provider,
   timestamp, prompt hashes, thinking usage, tool-schema hash, sandbox image / dependency-lock
   hash. Replication must first repeat the same snapshot, then test model transfer.
4. **Scope ceilings (do not vanish with a positive result).** Mostly Black/formatting;
   file(s)-given (no localization / navigation); single-file (mostly); Haiku + snapshot specific;
   D is one author's playbook; B1 tests relevance-placebo, not every placebo form. These are
   external-validity limits, not defects.

---

## Keep-honest verification (claude-api catalog, 2026-07-16)

- ✅ `claude-haiku-4-5-20251001` — verified exact snapshot.
- ✅ `thinking:{type:"enabled", budget_tokens:1024}` — the correct Haiku-4.5 form; adaptive would
  400; budget ≥1024 and `< max_tokens=4096`.
- ⚠️ **`output_config.effort` errors on Haiku 4.5** — the contract MUST omit it. A pre-pilot test
  must assert the adapter sends enabled+budget_tokens and NO effort for Haiku.
- ✅ omitting temperature/top_p/top_k is correct with thinking on.
- ✅ 200K context / 64K max output / $1 in / $5 out per 1M — verified; thinking billed as output.
- ⚠️ **training cutoff not verifiable from the claude-api skill** — confirm from the official
  Haiku 4.5 model card before relying on the pre/post-cutoff contamination stratum (snapshot date
  2025-10-01 is not the cutoff).
- ✅ `count_tokens` (model-specific) is the right $0 preflight tool; it is an estimate.

---

## Master freeze list before the first paid call

**Agent/config:** snapshot · budget_tokens · max_tokens · temperature/top_p/top_k omitted ·
effort omitted · max rounds · tool-call limits · stop rule · public-feedback sanitization ·
context cap/truncation · retry/timeout · circuit breakers.
**Corpus/evaluator:** manifest + folds · family map · target-file hashes · statement hashes ·
F2P/P2P mapping · verifier version + content hash · sandbox image · dependency locks.
**Conditions:** A render · frozen D (author, content hash, author_frozen) · B1 mapping/hash ·
C lesson schema · promotion/rejection/deprecation · bank cap + sort + tie-break · no-write in
held-out.
**Analysis:** primary comparisons C-vs-A, C-vs-B1, C-vs-D · metric defs · exact McNemar rule ·
fold-level reporting · stability gate · missing/error handling · contamination flags ·
continuation rule · **no change based on fold-1 results**.

**Next (all $0 until the pilot):** build the offline A/C/D/B1 solver harness with mocks over the
27 wired tasks (incl. a test asserting the Haiku thinking-kwargs / no-effort contract); run the
`count_tokens` context-cap preflight; then the budget-capped micro-pilot (fold 1 + stability
gate) — the first paid step, gated on explicit approval.
