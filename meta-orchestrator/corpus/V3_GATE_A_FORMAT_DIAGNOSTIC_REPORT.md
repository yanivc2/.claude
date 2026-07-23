# V3 Gate-A Post-Hoc Format Diagnostic — Report (EXPLORATORY)

**Dominant diagnosis: `INSUFFICIENT_RAW_EVIDENCE`.** The diagnostic cannot determine why the NEW
JSON contract failed (all 9 `NEW_MALFORMED`) because the raw model responses were not retained.
The official Gate-A result is unchanged and immutable: **FAIL** (OLD 4/9, NEW 0/9, NEW−OLD = −4).

## Gate 0 — raw-evidence precondition: FAILED

The Gate-A runner (`tools/v3_gate_a.py`) handed `resp.text` to the parser but never persisted it.
The sealed report kept only input/output tokens, cost, and the single `terminal_state`; each cell
work-directory holds only `ledger.json`. For all 18 cells there is **no raw text, no stop_reason,
no content-block structure, and no raw hash**. Per the frozen plan, when raw evidence is absent we
do not reconstruct it, do not re-send, and do not infer the root cause from the coarse decoded
labels — the diagnostic closes here.

## What is legitimately known (recorded terminal states — fact, not inference)

```
NEW: 9× NEW_MALFORMED   (0 NEW_TRUNCATED, 0 apply/ambiguous/overlap/syntax states)
OLD: 5× OLD_PATCH_SCHEMA_INVALID + 4× VALID_APPLIED_PATCH
```
A narrow, conservative reading: 0/9 NEW cells were recorded `NEW_TRUNCATED`, so the parser did not
receive an unterminated body — gross truncation is not indicated. But `NEW_MALFORMED` merges
*no-JSON*, *prose-around-JSON*, and *invalid-syntax*; the recorded label alone cannot tell them
apart, which is exactly why the raw responses were needed.

## The five decision questions — all UNANSWERABLE without raw

How many contained any JSON · how many were safe-normalizable · how many needed semantic repair ·
whether the failure was one uniform pattern or nine distinct ones · whether a third contract or a
repair-retry would fix a *defined* mechanism — none can be answered from the retained data.

## Honest process finding (observability gap)

Diagnosing format failures was Gate A's entire purpose, yet its runner did not save the very
evidence that diagnosis needs. This is a real miss. **Any future Gate A2 / third-contract run MUST
persist, per cell and byte-for-byte: the raw API response, content-block structure (thinking vs
text), the exact text passed to the parser, `stop_reason`, token counts, and a raw hash** — as a
durable, hashed artifact — before it is worth spending on another format micro-pilot.

## Recommendation

- Do **NOT** proceed to Gate B (the officially-tested contract FAILED, and the failure mechanism
  is undiagnosable from the retained data).
- If v3 continues, it requires a **fresh Gate A** whose runner captures raw responses; only then
  can the mechanism be localized (model non-compliance vs parser overstrictness vs prompt/schema
  defect) and a parser-normalization / third-contract / close decision be made on evidence.
- Everything remains immutable: no reruns, no reclassification, no threshold change, no official
  parser replacement, no paid calls. Sealed artifact sha256
  `a2ea0189ac299b02e54b8caf540e49a06c96a9e943fe514b91561ae0a7c62ee5` unchanged; v2.2 bank/results
  and apparatus untouched.

Machine record: `corpus/v3_gate_a_eval/v3_gate_a_format_diagnostic.json`.
