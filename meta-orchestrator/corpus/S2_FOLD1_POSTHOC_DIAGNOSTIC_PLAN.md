# §2 Fold-1 Post-Hoc Diagnostic Plan (FROZEN, EXPLORATORY)

```
analysis_type           = EXPLORATORY_POSTHOC
official_primary_result = unchanged (Δ(C−A)=-0.25, NEGATIVE_DIRECTION, two-sided p=0.625)
no_cells_rerun          = true    no_outcomes_reclassified = true
no_exclusions_added     = true    no_bank_changes          = true
```

This plan governs an EXPLORATORY investigation of **why** C did not help. It is not part of the
confirmatory analysis and changes no official number. It reads only already-collected,
already-unsealed data (the sealed records, now decoded) plus the public frozen bank; it makes no
paid call and mutates nothing. Findings live in `S2_FOLD1_POSTHOC_DIAGNOSTIC_FINDINGS.md`.

## Question A — was the retrieved memory relevant?

For each C cell: task, target family, injected lesson IDs, lesson source tasks, lesson text,
relevance classification. **Frozen relevance categories (defined here before classifying):**
```
DIRECTLY_RELEVANT      the lesson names the exact code path / transformation this bug requires
PARTIALLY_RELEVANT     same family and same sub-mechanism, but different specifics
GENERIC_ONLY           true but non-actionable generic advice for this task
IRRELEVANT             addresses a different mechanism than this bug
POTENTIALLY_MISLEADING could steer the model toward a wrong or out-of-scope edit
```

## Question B — were the lessons correct and useful?

Per lesson: correctness; specificity; actionability; applicability beyond its source task; risk
of overgeneralization; conflict with another active lesson; whether the 8-line/200-char render
truncation removed a critical qualification. No lesson is edited or improved.

## Question C — did C fail *because of* the memory?

Per task compare A/C/D/B1 outcome + C injected lessons + R1/R2 behavior + patch/apply status +
hidden outcome. Classify each C-vs-A pair: `C_ONLY_WIN / A_ONLY_WIN / BOTH_SOLVED / BOTH_FAILED`.
For every `A_ONLY_WIN`, look for TEXTUAL evidence that the model followed a wrong/distracting
lesson. **Causality is not inferred merely from the fact that a lesson was injected**; a C
failure whose mode is "no valid patch produced" is output-format noise, not memory harm, and is
labelled as such.

## Question D — apparatus or arena?

Apparatus/bank signals: lessons too generic; single-solve-derived lessons; sequential
feed-forward locking in an early error; families with only 1–2 lessons; coarse family routing;
truncation of a second lesson; no shared distillation; no-reference lesson writer; advice that
helps one style and harms another; **and — measured mechanically — a high rate of cells that
never produce a valid applied patch (malformed / apply-fail), which caps detectable signal.**
Arena signals: most A/C/D/B1 fail-or-succeed together; very few discordant pairs; tasks that
don't let procedural knowledge matter; between-run variance exceeding between-condition gaps;
fixes that hinge on local code specifics rather than family-level lessons.

## Outputs

1. Final pilot report (`S2_FOLD1_PILOT_FINAL_REPORT.md`).
2. This plan.
3. Per-task diagnostic table · 4. Per-lesson quality table · 5. Failure-mode summary ·
6. Apparatus-vs-arena diagnosis · 7. Recommendation STOP / REDESIGN / v3 PILOT
(all in `S2_FOLD1_POSTHOC_DIAGNOSTIC_FINDINGS.md`; mechanical counts in
`analysis/diagnostic.json` from `tools/s2_fold1_posthoc_diagnostic.py`).

A v3 recommendation is CONDITIONAL: proceed only if a plausible correctable mechanism is
identified, the new intervention differs materially from v2.2, the evaluation arena can expose
that intervention, and a new pre-registration + budget are approved.

## Not authorized by this plan

new paid calls · folds 2–3 · rerunning Fold-1 cells · changing official outcomes · changing or
rebuilding the v2.2 bank · v3 implementation · new model/provider · product/MVP development.
