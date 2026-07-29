# V3 Gate-A BLINDED Pre-Unseal Analysis Plan (FROZEN)

`BLINDED_PRE_UNSEAL_ANALYSIS_PLAN`. The Gate-A data are collected but SEALED (0 records decoded,
0 classification computed), so this plan is frozen outcome-independent. It authorizes NO unseal —
a separate explicit operator GO runs the analyzer once. This is an engineering qualification of
the output contract, NOT a memory-benefit test.

Bound artifacts (must match at unseal time):
```
sealed_artifact = corpus/v3_gate_a_eval/sealed_outcomes.jsonl
sealed_sha256   = a2ea0189ac299b02e54b8caf540e49a06c96a9e943fe514b91561ae0a7c62ee5
sealed_chain_head = 85d8434ba06bff25          sealed_entries = 18
manifest_hash   = 167338c4d7a7ae7d            master_anchor  = 022ac9fd0642eb73
analyzer        = tools/v3_gate_a_unseal_analyze.py
```

## Metrics (computed on decode; nothing else)

Per each of the 9 tasks, per contract arm (OLD, NEW):
```
valid_applied                (0/1)   — the cell's VALID_APPLIED_PATCH terminal state
silent_partial_application   (0/1)   — a non-valid state that still mutated the source (must be 0)
ambiguous_accepted           (0/1)   — an ambiguous-anchor edit that was applied (must be 0)
deterministic_replay_failure (0/1)   — reserved; the applier is deterministic by construction (0)
```
Summary:
```
OLD_valid_applied_count      = Σ OLD valid_applied over 9 tasks
NEW_valid_applied_count      = Σ NEW valid_applied over 9 tasks
paired_improvement           = count(OLD=0, NEW=1) − count(OLD=1, NEW=0)
NEW_minus_OLD                = NEW_valid_applied_count − OLD_valid_applied_count
```

## Frozen classification (thresholds — NEVER changed after disclosure)

```
PASS:
  NEW_valid_applied >= 8/9
  AND NEW_minus_OLD >= 3
  AND total silent_partial_application    = 0
  AND total ambiguous_accepted            = 0
  AND total deterministic_replay_failure  = 0

BORDERLINE:
  NEW_valid_applied == 7/9
  OR (NEW_valid_applied >= 8/9 AND NEW_minus_OLD in {1, 2})

FAIL / NO-GO:
  NEW_valid_applied <= 6/9
  OR any silent_partial_application
  OR any ambiguous_accepted
  OR any deterministic_replay_failure
  OR NEW_minus_OLD <= 0
```
Evaluation order: any hard failure (silent-partial / ambiguous / replay) forces FAIL; else if
the PASS conjunction holds → PASS; else if a BORDERLINE clause holds → BORDERLINE; else FAIL.
Public/hidden solve rates and costs may appear as SECONDARY descriptive metrics only; they may
NOT change the Gate-A classification.

## Unseal mechanism (one-shot, atomic)

```
verify durable checkpoint → verify sealed artifact SHA-256 → verify chain head + 18 entries →
verify manifest / prereg / analyzer-source hashes → decode all 18 cells →
validate exact 9x2 completeness (no dup / no missing / correct manifest / no unknown outcome) →
compute the frozen classification → write outputs atomically → record audit hashes
```
Audit: input_artifact_sha256, sealed_chain_head, analysis_plan_hash, analyzer_source_hash,
unseal_timestamp, decoded_cell_table_hash, analysis_json_hash, analysis_report_hash. FORBIDDEN:
preview of one record, manual decode, partial output, changing thresholds, excluding a task after
viewing, re-running any cell. If validation fails after unseal begins, write an audit error only.

## Decision after classification

- **PASS** → plan Gate B (learning) under a fresh pre-registration + budget. Not automatic.
- **BORDERLINE** → do NOT start Gate B; analyse format failures; decide re-pilot or close.
- **FAIL / NO-GO** → close this v3 contract direction or design another; no "fix in flight",
  no Gate B.
This plan classifies the output contract only; it makes no claim about learning.
