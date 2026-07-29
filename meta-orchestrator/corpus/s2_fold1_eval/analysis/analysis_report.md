# §2 Fold-1 Held-Out Evaluation — Analysis Report

## 1. Integrity & unseal audit
{"cells": 48, "excluded": {"cookiecutter-18": "PARITY_BLOCKED_BEFORE_SEND"}, "unit_level_task_count": 8, "unit_of_analysis": "held-out task"}

## 2. Cell-completeness
{"missing_outcome_cells": 0, "post_unseal_exclusions": 0, "primary_cells": 32, "stability_cells": 16}

## 3. PRIMARY C vs A
- Δ(C−A) = -0.25  (C=1 A=3 of 8)
- discordant: C-only=1 A-only=3 both=0 neither=4
- exact one-sided p (C>A) = 0.9375  two-sided = 0.625
- **evidence_class = NEGATIVE_DIRECTION**

## 4. Secondary C vs B1
- Δ = -0.125  discordant=1  one-sided p = 1.0  Holm = 1.0

## 5. Secondary C vs D
- Δ = -0.125  discordant=3  one-sided p = 0.875  Holm = 1.0

## 6. Stability
{"A": {"agreement_rate": 0.875, "both_failed": 5, "both_solved": 2, "primary_failed_rep_solved": 0, "primary_solved_rep_failed": 1}, "C": {"agreement_rate": 0.875, "both_failed": 7, "both_solved": 0, "primary_failed_rep_solved": 0, "primary_solved_rep_failed": 1}, "delta_rep_C_minus_A": -0.25, "note": "robustness only; 16 A-runs + 16 C-runs are NOT 32 independent units \u2014 inference stays clustered/paired by 8 tasks"}

## 7. Per-task paired table
- black-133 [iterator]: A=0 C=1 D=0 B1=1
- black-1632 [whitespace]: A=0 C=0 D=0 B1=0
- black-183 [parser_normalization]: A=1 C=0 D=1 B1=0
- black-234 [iterator]: A=1 C=0 D=0 B1=0
- black-329 [whitespace]: A=0 C=0 D=0 B1=0
- black-60 [whitespace]: A=0 C=0 D=1 B1=0
- black-74 [other_logic]: A=0 C=0 D=0 B1=0
- black-95 [iterator]: A=1 C=0 D=0 B1=1

## 8. Per-family (descriptive only)
- iterator (n=3): A=2 C=1 D=0 B1=2 | C−A=-1 C−D=1 C−B1=-1
- other_logic (n=1): A=0 C=0 D=0 B1=0 | C−A=0 C−D=0 C−B1=0
- parser_normalization (n=1): A=1 C=0 D=1 B1=0 | C−A=-1 C−D=-1 C−B1=0
- whitespace (n=3): A=0 C=0 D=1 B1=0 | C−A=0 C−D=-1 C−B1=0

## 9. Cost / efficiency
{"A": {"api_calls": 9, "cost_per_solved_usd": 0.08842133, "mean_spend_per_task_usd": 0.033158, "r2_count": 1, "solved_count": 3, "total_spend_usd": 0.265264}, "A_stability": {"api_calls": 9, "r2_count": 1, "total_spend_usd": 0.261686}, "B1": {"api_calls": 9, "cost_per_solved_usd": 0.1319855, "mean_spend_per_task_usd": 0.03299638, "r2_count": 1, "solved_count": 2, "total_spend_usd": 0.263971}, "C": {"api_calls": 9, "cost_per_solved_usd": 0.269902, "mean_spend_per_task_usd": 0.03373775, "r2_count": 1, "solved_count": 1, "total_spend_usd": 0.269902}, "C_stability": {"api_calls": 9, "r2_count": 1, "total_spend_usd": 0.273675}, "D": {"api_calls": 9, "cost_per_solved_usd": 0.1213105, "mean_spend_per_task_usd": 0.03032763, "r2_count": 1, "solved_count": 2, "total_spend_usd": 0.242621}}

## 10. Claim boundary
{"boundary_family": "NOT_EVALUATED", "boundary_generalization": "NOT_ESTABLISHED", "claim_scope": "WITHIN_FOLD_CAUSAL_EVIDENCE", "cross_fold_generalization": "NOT_ESTABLISHED", "directional_pilot": true, "unit_level_task_count": 8}
