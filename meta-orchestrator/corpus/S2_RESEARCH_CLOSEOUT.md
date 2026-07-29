# §2 Research Closeout — Learned Procedural Memory for Code Repair

**Status: CLOSED at a justified stopping point.** This is the authoritative final record. It does
not end the possibility of future work; it records that the current experiment reached a
well-founded stop. Reopening requires a NEW, separate project (see §5) — never a continuation of
this one.

## 1. Official conclusion (exact)

The experimental apparatus, the memory mechanism, and the held-out evaluation worked end-to-end.
In the Fold-1 pilot **no evidence was found that learned memory improves success over no-memory**,
and the primary estimate was negative but not significant. The v3 check showed that the proposed
JSON output contract **is not qualified for Haiku in the tested configuration**: it produced **0
valid applied patches out of 9** tasks, versus 4 under the previous contract. Because the raw
responses were not retained, it **cannot be determined post-hoc whether that failure came from the
model, the prompt/schema, or parser strictness**. There is therefore no justification to proceed to
Gate B or to any further learning experiment within the current research.

## 2. Honest status (no unqualified "success")

```
Fold-1 causal pilot methodology   = sound
Gate-A official classification    = valid
Gate-A diagnostic observability   = deficient   (raw responses were not persisted)
Product hypothesis                = NOT supported
```

## 3. Result record (immutable)

```
v2.2 memory result:   Δ(C−A) = −0.25 · n = 8 · two-sided p = 0.625 · positive benefit NOT SHOWN
  v2.2 diagnosis:     apparatus-dominated — 19/32 primary cells produced no valid applied patch
v3 Gate A:            OLD valid-applied = 4/9 · NEW valid-applied = 0/9 · classification = FAIL
v3 Gate-A diagnosis:  INSUFFICIENT_RAW_EVIDENCE (raw responses not retained; cause unlocalizable)
```
Primary sources (unchanged): `S2_FOLD1_PILOT_FINAL_REPORT.md`,
`S2_FOLD1_POSTHOC_DIAGNOSTIC_FINDINGS.md`, `corpus/v3_gate_a_eval/analysis/` (Gate-A FAIL),
`V3_GATE_A_FORMAT_DIAGNOSTIC_REPORT.md`.

## 4. Frozen / read-only artifacts (do NOT modify, re-run, or reinterpret)

```
v2.2 C bank                 corpus/s2_fold1_c_bank.frozen.json        (content_hash 513d63007784)
v2.2 official training log  corpus/s2_official_training_log.json      (content_hash fd0d42b7e3999924)
v2.2 paid spend ledger      corpus/s2_paid_spend_ledger.json          (content_hash 42845ca2a1034139)
v2.2 held-out sealed eval   corpus/s2_fold1_eval/sealed_outcomes.jsonl (sha256 53dec53d…, head 3d3b29252863c7be)
v2.2 held-out analysis      corpus/s2_fold1_eval/analysis/            (analysis_json_hash 2ac09c69…)
v3 Gate-A sealed run        corpus/v3_gate_a_eval/sealed_outcomes.jsonl (sha256 a2ea0189…, head 85d8434ba06bff25)
v3 Gate-A analysis          corpus/v3_gate_a_eval/analysis/           (classification FAIL)
```
`OFFICIAL_RESULTS = IMMUTABLE`. No retroactive edits, no reclassification, no success-implying
rewrites. Total paid across the whole research: v2.2 $2.513395 + Gate-A $0.484091 = **$2.997486**
(global $50 cap never approached).

## 5. Mandatory requirements for ANY future work (non-negotiable)

A future attempt is a NEW project (new hypothesis grounded in evidence, new apparatus identifier,
new pre-registration, new manifest + budget, engineering qualification before any memory
evaluation) — not a "Gate A2" of this research. Before it may receive a SEND-GO, its runner MUST
persist, per cell and byte-for-byte, and these fields MUST be verified present on a synthetic
fixture AND one dry-run before the first paid call:

```
- exact raw provider response (byte-for-byte)
- ordered content blocks + block types (thinking vs text)
- the exact text supplied to the parser
- stop_reason + usage metadata (token counts)
- raw-response SHA-256
- parser version/hash + the exact parser error
- raw evidence preserved BEFORE any outcome summarization
```
The v3 Gate-A observability defect (raw not saved, so a FAIL could not be diagnosed) is the direct
lesson: without this, a format-failure result is uninterpretable and not worth paying for.

## 6. Not authorized (research closed)

Gate A2 · a third output contract · rerun of the nine NEW cells · a parser-normalization
experiment · repair-retry calls · Gate B · a distilled bank · folds 2–3 · any new API call.
Reopening requires a fresh, separately-authorized project per §5.
