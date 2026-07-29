# V3 Gate-A Post-Hoc Format Diagnostic Plan (FROZEN, EXPLORATORY)

```
analysis_type                  = EXPLORATORY_POSTHOC
official_gate_a_classification = FAIL_IMMUTABLE   (OLD 4/9, NEW 0/9, NEW-OLD=-4)
no_reruns                      = true
no_outcome_reclassification    = true
no_threshold_changes           = true
no_official_parser_replacement = true
no_paid_calls                  = true
```

Goal: determine whether the NEW-contract failure (all 9 cells `NEW_MALFORMED`) is
MODEL_CONTRACT_NONCOMPLIANCE, PARSER_OVERSTRICTNESS, PROMPT_CONTRACT_DEFECT, RESPONSE_TRUNCATION,
or a mix — WITHOUT changing the official FAIL result. This plan is frozen and committed BEFORE any
inspection of the nine NEW outputs.

## Gate 0 — raw-evidence precondition (checked first, before any content analysis)

```
raw responses present         = REQUIRED
raw response hashes available = REQUIRED
response metadata present     = preferred
```

If the raw responses were not retained byte-for-byte: do NOT reconstruct them, do NOT re-send any
request, and do NOT infer the root cause from the decoded summaries (the `NEW_MALFORMED` label is
too coarse — it merges prose-around-JSON, no-JSON, invalid-syntax, and truncation). In that case
the diagnostic is closed as:

```
dominant_diagnosis = INSUFFICIENT_RAW_EVIDENCE
```

## Analysis (only if Gate 0 passes)

Per NEW cell, from the raw response only: content-block structure (thinking vs text), exact text
passed to the parser, stop_reason, token counts, parser/schema/application error. Primary
single-label failure per cell (EMPTY_OR_NO_TEXT / TRUNCATED / NO_JSON_PRESENT /
MARKDOWN_FENCED_JSON / PROSE_AROUND_JSON / JSON_SYNTAX_INVALID / MULTIPLE_JSON_CANDIDATES /
JSON_VALID_SCHEMA_INVALID / SCHEMA_VALID_ANCHOR_NOT_FOUND / SCHEMA_VALID_ANCHOR_AMBIGUOUS /
SCHEMA_VALID_APPLICATION_FAILED / EXACT_CONTRACT_COMPLIANT).

Three recoverability levels (compute; never change the official result):
- **Level 0 Exact** — passes the frozen parser unchanged.
- **Level 1 Safe normalization** — ONLY: trim whitespace, strip a UTF-8 BOM, unwrap exactly one
  outer ```json fence. Forbidden: searching JSON inside prose, fixing commas/quotes/brackets,
  renaming fields, choosing among multiple objects.
- **Level 2 Semantic repair required** — anything needing a guess or content change.

Dominant-diagnosis rule:
```
PARSER_OVERSTRICTNESS_DOMINANT       : safe-normalizable >= 7/9
MODEL_CONTRACT_NONCOMPLIANCE_DOMINANT: safe-normalizable <= 2/9 AND most need semantic repair / no useful JSON
PROMPT_OR_SCHEMA_DESIGN_DEFECT       : a consistent pattern (same wrong field >=7/9, example-induced wrapping, instruction/schema contradiction)
MIXED_FAILURE                        : no dominant mechanism
```

## Continuation recommendation by finding

```
PARSER_OVERSTRICTNESS_DOMINANT        -> may design a separate Gate A2 with a safe normalizer only
PROMPT_OR_SCHEMA_DESIGN_DEFECT        -> may design a third contract, new pre-registration + Gate A
MODEL_CONTRACT_NONCOMPLIANCE_DOMINANT -> close the structured-JSON direction for Haiku in this arena
MIXED_FAILURE / INSUFFICIENT_RAW_EVIDENCE -> no Gate B; broad redesign or close
```
In every case there is NO direct path to Gate B: the officially-tested contract FAILED, so any
continuation needs a fresh Gate A.

## Outputs

`V3_GATE_A_FORMAT_DIAGNOSTIC_REPORT.md` + `v3_gate_a_format_diagnostic.json` (per-cell table +
counts + dominant diagnosis + recommendation). Long raw text is not printed; if raw exists it is
preserved as a durable hashed artifact.

## Not authorized

new API calls · rerun of any Gate-A cell · Gate B · threshold changes · official reclassification ·
modification of the original raw responses · replacement of the official parser · new
output-contract experiment.
