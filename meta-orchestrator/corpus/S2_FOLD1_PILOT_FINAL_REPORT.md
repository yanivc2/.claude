# §2 Fold-1 Directional Pilot — Final Report

**Status: complete. Result: no evidence of a positive learned-memory benefit; the engineering
apparatus is proven to work, its effectiveness is not.** This is a directional pilot on n=8
held-out tasks, not a proof.

## 1. Goal & estimand

Test whether a **learned** procedural-memory policy (condition C) improves held-out repair
success versus no-memory (A), a relevance placebo (B1), and a static hand-written playbook (D),
on Black formatting-repair tasks in a file-given single-file configuration with a locked Haiku
snapshot. Primary estimand (frozen before unseal):
```
Δ(C−A) = mean_task[ solved(C_primary) − solved(A_primary) ]   (unit = held-out task, n = 8)
```
Primary outcome = the frozen HIDDEN (F2P) verdict; SOLVED=1 / FAILED=0. The public suite is
never the primary outcome.

## 2. Pre-registered decisions & exclusions (all fixed before outcomes)

- 3-fold stratified design; this pilot is **fold-1-only** (`FOLD_1_ONLY`, decided before any
  paid evaluation, provider-funding constraint, outcome-independent).
- Four conditions A/C/D/B1; identical frozen apparatus v2.2; only the memory slot varies.
- Authoritative C/B1 token-parity gate (real `count_tokens`); Latin-square condition order;
  A/C stability reps (robustness only, never pooled into the estimate).
- **cookiecutter-18 excluded** `PARITY_BLOCKED_BEFORE_SEND` (C_mem=134 vs B1_mem=101, gap=33,
  25% > frozen thresholds) — 0 paid cells, 0 outcomes, $0; not a FAILED, never in any success
  computation. Evaluated tasks therefore = **8**.
- Sealed outcomes; one-shot deterministic unseal under a pre-frozen blinded analysis plan.

## 3. Evaluated tasks (8)

black-133 (iterator), black-1632 (whitespace), black-183 (parser_normalization),
black-234 (iterator), black-329 (whitespace), black-60 (whitespace), black-74 (other_logic),
black-95 (iterator). black-183 evaluated with an empty C slot (no boundary/parser lessons in
the bank) → C structurally identical to A for that task.

## 4. Primary result — C vs A

```
C solved = 1 / 8      A solved = 3 / 8      Δ(C−A) = −0.25
discordant: C-only wins = 1, A-only wins = 3, both-solved = 0, both-failed = 4
exact one-sided p (H1: C>A) = 0.9375     two-sided exact p = 0.625
evidence_class = NEGATIVE_DIRECTION
```

**Conclusion (exact wording):** In the Fold-1 pilot, no evidence was found that learned memory
improves success over no-memory. The point estimate was even negative in direction, but the
sample is small and the result is not significant, so it must NOT be concluded that the true
effect is necessarily zero or negative.

## 5. Secondary results

```
Δ(C−B1) = −0.125   (discordant 1)   one-sided p = 1.0    Holm-adjusted = 1.0
Δ(C−D)  = −0.125   (discordant 3)   one-sided p = 0.875  Holm-adjusted = 1.0
```
C did not beat the relevance placebo or the static playbook either. Secondary only; they do not
replace C−A.

## 6. Stability (robustness only)

A and C each: agreement 0.875 across the 8 tasks (one primary-vs-rep flip each). Replicated
sensitivity `Δrep(C−A) = −0.25` — consistent with the primary. Execution is reasonably stable;
the null is not an artifact of run-to-run chaos at the whole-condition level (but see §8: the
per-cell output-format failures ARE stochastic).

## 7. Cost / efficiency (secondary)

Primary-cell spend: A $0.2653, C $0.2699, D $0.2426, B1 $0.2640 (near-identical by design).
Cost per verified SOLVED: A $0.088, D $0.121, B1 $0.132, C $0.270 (C highest because it solved
fewest). Total paid evaluation: **$1.577119**; remaining reported credits $2.385544.

## 8. What worked, and the binding limitation

**The engineering apparatus is validated end-to-end:** repo-backed reproduction, hidden F2P
grading under network isolation, label-free memory injection, authoritative token-parity,
per-cell single-use grants, atomic budget reservation, and hash-sealed blinded evaluation with a
deterministic one-shot unseal — all ran with 0 ambiguity and 0 integrity failures.

**Its effectiveness is not demonstrated, and the pilot was largely unable to test it** because
the v2.2 output contract dominated the outcomes: **19 of 32 primary cells (59%) never produced a
valid applied patch** (15 malformed SEARCH/REPLACE outputs + 4 apply failures). When a valid
patch WAS produced, the hidden pass rate was 8/13 (~62%). See
`S2_FOLD1_POSTHOC_DIAGNOSTIC_FINDINGS.md` for the mechanism analysis.

## 9. Claim boundaries (binding)

```
claim_scope               = WITHIN_FOLD_CAUSAL_EVIDENCE   (8 tasks, fold-1, Black, Haiku, v2.2)
unit_level_task_count     = 8   (the 48 cells are NOT 48 independent observations)
boundary_family           = NOT_EVALUATED
boundary_generalization   = NOT_ESTABLISHED
cross_fold_generalization = NOT_ESTABLISHED
```
A directional pilot, not a general claim about whether procedural-memory learning works.

## 10. Audit trail

Sealed artifact `corpus/s2_fold1_eval/sealed_outcomes.jsonl` (sha256 53dec53d…, chain head
3d3b29252863c7be, 48 entries, unchanged by analysis). Analysis: `analysis/analysis.json` +
`analysis/analysis_report.md` + `analysis/unseal_audit.json` (analysis_json_hash 2ac09c69…).
Manifest d6a5919ab7bb3bec @ HEAD cdbef08; blinded plan `S2_FOLD1_BLINDED_ANALYSIS_PLAN.md`.
Bank 513d63007784 and apparatus v2.2 unchanged throughout.
