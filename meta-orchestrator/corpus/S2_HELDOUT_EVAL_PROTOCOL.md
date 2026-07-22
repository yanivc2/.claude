# §2 Fold-1 Held-Out Evaluation Protocol (pre-registered, $0 — no paid call authorized by this doc)

**Status: frozen BEFORE the first held-out call.** This document pre-registers how the fold-1
held-out evaluation will run, what may be observed while it runs, and when outcomes unseal. It
authorizes nothing by itself: paid execution still requires the operator's explicit authorization,
per-attempt grants, and the gate/anchor chain.

## 1. What is being evaluated

The 9 held-out tasks of fold index 1 (`s2_family_map.json` fold_split[1].test_ids):
black-133, black-1632, black-183, black-234, black-329, black-60, black-74, black-95,
cookiecutter-18 — under four conditions (A / C / D / B1) with the identical frozen apparatus
v2.2; **only the memory slot differs** (Decision B/C). The estimand is the held-out C−A (and
C−B1, C−D) contrast. Training solve-rates are NOT part of the estimand.

- Bank: `s2_fold1_c_bank.frozen.json` (bank_content_hash `513d63007784`) — READ-ONLY. Held-out
  never writes (frozen bank + `is_train=False` + runner zero-write assertions).
- D: `d_playbook.frozen.json` (`5bd2d42c…`, external author, author_frozen).
- B1: count-matched to C via the frozen derangement + fallback policy
  (`s2_memory_injection_policy.frozen.json`); token-parity gate per Decision/memory policy.
- 8/9 held-out tasks are bank-covered; black-183 (parser_normalization) evaluates with an empty
  C slot (Option B: C==A for that task, pre-declared).

## 2. Execution plan (frozen, outcome-independent)

`heldout_eval.build_eval_plan` over the 9 tasks:
- **Primary block** (rep 0): each task × all four conditions in its frozen Latin-square rotation
  (`ordering.condition_order`) → 36 attempts.
- **Stability block** (rep 1, Decision D addendum): A and C once more per task against the SAME
  frozen bank (execution stability, not learning stability) → 18 attempts.
- Plan artifact is content-hashed and recorded before the first call. Stability attempts are
  never pooled into the primary estimate.

Retry policy for infra errors: `ordering.RETRY_POLICY` (condition-blind, max 2, on-exhausted →
withhold the paired task; infra is NEVER recorded as a condition FAIL).

## 3. Sealed outcomes (Decision E keep-honest operationalization)

Every attempt's full report (hidden verdict, public statuses, rounds, patch state, memory
telemetry) is written ONLY to the append-only, hash-chained, obfuscated
`SealedOutcomeStore`. While the evaluation is in progress:

- The runner returns and the operator sees ONLY the redacted operational view:
  cost, calls sent, infra status, grant accounting (`ALLOWED_VISIBLE_KEYS`).
- Continue/stop decisions read ONLY {stability of the harness, cost, harness health,
  circuit-breakers} — never any outcome field.
- Progress reports to the operator state counts of attempts completed and spend — never
  outcomes, in any direction, for any condition.

**Unseal happens ONLY on one of the two pre-declared reasons** (`UNSEAL_REASONS`):
1. `all_folds_complete` — for fold-1-only scope: all 54 fold-1 attempts terminal (or withheld
   per the retry policy). If the operator later authorizes folds 2–3 BEFORE unsealing, unseal
   waits for all authorized folds.
2. `predeclared_stop_trigger` — a frozen stop condition fired (budget breach, harness-health
   failure, repeated infra instability, operator abort). The partial table is then opened for
   diagnosis and the run is labeled accordingly (exploratory if resumed after inspection).

Reading the raw store file outside `outcome_table` is a protocol violation; the chain +
digests make any tamper/edit detectable.

**Honest limitation:** sealing is procedural, not cryptographic — the store lives on the same
machine and base64 is obfuscation, not encryption. Its purpose is to prevent accidental
disclosure and to make deliberate disclosure detectable/auditable, which is what Decision E's
keep-honest clause requires.

**Pre-declared caveat on visible cost:** cost per attempt coarsely correlates with whether R2
opened (2 calls ≈ 2× cost). Cost is explicitly a permitted continue/stop signal in Decision E;
this residual leakage is accepted and disclosed here, and per-attempt costs will not be broken
out by condition in progress reports (only running totals).

## 4. Scope decision (FIXED by the operator, 2026-07-21 — BEFORE any paid evaluation call)

```
evaluation_scope                 = FOLD_1_ONLY
scope_decision_timing            = BEFORE_PAID_EVALUATION
scope_reason                     = PROVIDER_FUNDING_CONSTRAINT
decision_independent_of_outcomes = true
claim_scope                      = WITHIN_FOLD_CAUSAL_EVIDENCE
cross_fold_generalization        = NOT_ESTABLISHED
```

The fold-1 evaluation is a controlled within-fold causal comparison; it does NOT establish
cross-fold generalization. Consequently, `all_folds_complete` for the unseal rule of §3 means:
**all 54 fold-1 attempts terminal (or withheld per the retry policy)** — nothing more.

If folds 2–3 are ever funded, they run as a SEPARATE replication extension: a new
pre-registration, a new budget, a new frozen manifest, and separate reporting — never presented
as if the original scope had been three folds, and never stacked onto this unseal decision.

## 4a. Scope amendment 1 (2026-07-21, operator-approved) — cookiecutter-18 excluded PRE-SEND

```
reason            = hard frozen C/B1 authoritative token-parity block
timing            = before the first paid evaluation call
observed_outcomes = none          financial_spend = $0
decision          = exclude the ENTIRE task (never selected conditions)
effect            = Fold-1 evaluation reduced from 54 to 48 cells
```

During the pre-send authoritative parity stage (real `count_tokens`, $0), 7/8 memory-bearing
held-out tasks passed and **cookiecutter-18 blocked**:

```
task_id                 = cookiecutter-18
evaluation_disposition  = PARITY_BLOCKED_BEFORE_SEND
C_memory_tokens         = 134       B1_memory_tokens = 101
absolute_gap            = 33        relative_gap     = 25%
frozen_gate             = BLOCK     (thresholds: >32 AND >20%; authority: count_tokens)
paid_cells_executed     = 0         outcome_generated = false        cost = $0
```

cookiecutter-18 is NOT classified as FAILED and never enters any success computation. A partial
A+D-only block for it was considered and rejected (unbalanced, contributes nothing to the C
contrasts). The frozen parity policy, runner, prompts, and apparatus are unchanged.

**Amended estimand + binding claim limits:**

```
original_held_out_tasks              = 9
evaluated_parity_eligible_tasks      = 8
excluded_before_outcomes             = cookiecutter-18
boundary-family memory-bearing coverage = absent
generalization_to_boundary_family    = NOT_ESTABLISHED
unit_level_task_count                = 8   (48 cells are NOT 48 independent tasks)
```

**Superseded artifacts (audit trail; nothing consumed):**

```
manifest 3c009b6c6a7abe08 = SUPERSEDED_PRE_SEND
anchor   86d90eef1fa3e099 = SUPERSEDED_PRE_SEND
54 old grants             = INVALID_FOR_USE / NEVER_CONSUMED (0 calls used)
old sealed store          = empty, archival; a NEW store is initialized for the 48-cell manifest
```

The amended plan: 8 tasks × 4 conditions = 32 primary cells + 8 × 2 = 16 stability cells = 48.
`all_folds_complete` for the unseal rule now means: all 48 amended-manifest cells terminal (or
withheld per the retry policy).

## 5. Batched authorization model (proposed, requires explicit operator GO)

Evaluation is stateless w.r.t. the bank (read-only, no cross-attempt dependency), so a single
operator authorization MAY cover the whole 54-attempt block, with: per-attempt single-use
grants minted mechanically under one anchor; per-attempt exposure caps; the fold/global budget
gates live on every call; and the frozen stop conditions from the accelerated-mode protocol.
Gate-1 evidence (full suite + count_tokens) is re-established whenever HEAD changes and reused
hash-verified within an unchanged-HEAD block — authorization ceremony, not measurement, so this
does not touch the frozen apparatus.

## 6. What this changes about v2.2

Nothing. No frozen artifact, prompt, grading rule, or write-gate is modified. This document +
`heldout_eval.py` add evaluation-side infrastructure only; the training apparatus and all
recorded results stand as-is.
