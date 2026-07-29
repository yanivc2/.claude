# §2 Fold-1 BLINDED Pre-Unseal Statistical Analysis Plan (FROZEN)

**Classification: `BLINDED_PRE_UNSEAL_STATISTICAL_ANALYSIS_PLAN`.** The paid data are already
collected but remain SEALED (0 records decoded, 0 outcomes computed). This plan is therefore
still **outcome-independent**: it is frozen BEFORE any unseal so the analysis is deterministic
and specified in advance, not chosen after seeing results. This document authorizes NO unseal —
a separate explicit operator GO is required to run the analyzer once.

Bound artifacts (must match at unseal time):
```
sealed_artifact  = corpus/s2_fold1_eval/sealed_outcomes.jsonl
sealed_sha256    = 53dec53d14d3ccde1ae77d6c21c10505ed6efea97f50cebad3e28c5e9a32edc9
sealed_chain_head= 3d3b29252863c7be
sealed_entries   = 48
manifest_hash    = d6a5919ab7bb3bec
analyzer         = tools/s2_fold1_unseal_analyze.py
```

## 1. Unit of analysis

```
unit_of_analysis      = held-out task
unit_level_task_count = 8
```
The 48 cells are NOT 48 independent observations. Each task is one unit. The 16 stability
cells do NOT raise n from 8 to 16. `cookiecutter-18` stays out entirely
(`PARITY_BLOCKED_BEFORE_SEND`, outcome = none).

## 2. Primary outcome

```
SOLVED = 1   FAILED = 0
```
Based on the frozen HIDDEN final-state verdict only (`report.hidden_verdict is True` → 1, else
0; a terminal solver failure with no applied patch → hidden_verdict None → 0). The public
PASS/FAIL is NEVER the primary outcome. All 48 cells are terminal with 0 infra ambiguity, so:
```
missing_outcome_cells   = 0   (asserted at unseal; else audit error, no partial analysis)
post_unseal_exclusions  = FORBIDDEN
```

## 3. Primary contrast (primary cells only — rep 0)

```
PRIMARY ESTIMAND: Δ(C−A) = mean_task[ solved(C_primary) − solved(A_primary) ]
```
Report: C solved count, A solved count, paired solve difference, paired success-rate
difference, C-only wins (C=1,A=0), A-only wins (A=1,C=0), both-solved ties, both-failed ties.

**Primary test:** exact paired McNemar / exact sign test on the discordant pairs, directional
alternative **C > A** (one-sided). Also report the two-sided exact p-value for transparency.
A positive Δ alone is NEVER called "proven". Evidence class:
```
POSITIVE_STATISTICAL_EVIDENCE : Δ(C−A) > 0  AND one-sided exact p <= 0.05
DIRECTIONAL_POSITIVE_ONLY     : Δ(C−A) > 0  AND p > 0.05
NO_POSITIVE_EFFECT            : Δ(C−A) = 0
NEGATIVE_DIRECTION            : Δ(C−A) < 0
```

## 4. Secondary contrasts (primary cells only)

`Δ(C−B1)` and `Δ(C−D)`, each paired at task level over the primary cells. Per contrast report:
success counts, paired difference, discordant pairs, exact one-sided AND two-sided p-values.
These are SECONDARY — they never replace C−A as the primary measure after unseal. Apply **Holm
correction** across the two secondary comparisons {C vs B1, C vs D}; present both raw and
Holm-adjusted p-values.

## 5. Stability reps (A and C only) — robustness, not inference on n

Within-condition stability, per condition X ∈ {A, C}: agreement between X_primary and X_rep1 —
both solved / both failed / primary-solved-rep-failed / primary-failed-rep-solved / agreement
rate. Replicated sensitivity, per task: `X_mean_i = (X_primary_i + X_rep1_i)/2`,
`Δrep(C−A) = mean_task[C_mean_i − A_mean_i]` — robustness only. The 16 A-runs and 16 C-runs are
NEVER treated as 32 independent units; every inferential computation stays clustered/paired by
the 8 tasks. An exact within-task label permutation on the A/C bundles is permitted as a
supplement but never replaces the primary analysis.

## 6. Per-family analysis — DESCRIPTIVE ONLY

Table: family, task count, A/C/D/B1 solves, C−A, C−D, C−B1. No per-family significance claims
(sample too small). Declare: `boundary family = NOT EVALUATED`,
`boundary generalization = NOT ESTABLISHED`, `cross-fold generalization = NOT ESTABLISHED`.

## 7. Cost / efficiency — SECONDARY

Per condition over primary cells: total spend, mean spend per task, API call count, R2 count,
cost per verified SOLVED (`undefined` when solved_count == 0 — no division by zero). A and C
also report stability-cell spend separately. Economic metrics never change the scientific
success classification.

## 8. Frozen output order

```
1. Integrity and unseal audit      2. Cell-completeness table
3. Primary C-vs-A analysis         4. Secondary C-vs-B1 analysis
5. Secondary C-vs-D analysis       6. Stability analysis
7. Per-task paired table           8. Per-family descriptive table
9. Cost/efficiency table          10. Claim-boundary statement
11. Machine-readable JSON
```
The analyzer must NOT hunt for an "interesting" result or start with the per-family breakdown
before presenting the primary analysis.

## Unseal mechanism (one-shot, atomic)

```
verify checkpoint → verify sealed artifact SHA-256 → verify chain head + 48 entries →
verify analysis-plan hash → verify analyzer source hash → decode all 48 records →
validate manifest completeness (48/48, no dup, no missing, task-level pairing) →
compute the frozen analyses → write outputs atomically → record audit hashes
```
Audit record: input_artifact_sha256, sealed_chain_head, analysis_plan_hash,
analyzer_source_hash, unseal_timestamp, decoded_cell_table_hash, analysis_json_hash,
analysis_report_hash. FORBIDDEN: decode one record for inspection, manual preview, interactive
filtering, changing calculations after seeing outcomes, dropping inconvenient tasks/cells. If
validation fails after the unseal begins, save an audit error only — never a partial analysis.

## Claim boundaries (binding)

```
claim_scope               = WITHIN_FOLD_CAUSAL_EVIDENCE
unit_level_task_count     = 8
boundary_generalization   = NOT_ESTABLISHED
cross_fold_generalization = NOT_ESTABLISHED
```
The analysis speaks only to the 8 parity-eligible fold-1 held-out tasks under the frozen
apparatus v2.2. It is a directional pilot, not a proof of learning in general.
