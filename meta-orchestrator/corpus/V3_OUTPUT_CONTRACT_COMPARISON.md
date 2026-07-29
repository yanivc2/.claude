# v3 Output-Contract Comparison (offline, $0)

The v2.2 pilot's dominant failure was the output contract: **19/32 primary cells (59%) produced
no valid applied patch** — 15 malformed SEARCH/REPLACE outputs + 4 exact-anchor apply failures.
v3's first job is to drive that rate down so a memory effect can even be observed. Three
candidates were evaluated against the failure modes we actually saw.

## Failure modes to fix (from the v2.2 diagnostic)

- **Malformed structure (47%)**: the custom `### PATCH / <<<<<<< SEARCH / ======= / >>>>>>> REPLACE
  / ### END` fence plus a leading `### LESSON` JSON block, under extended thinking, is hard for
  Haiku to emit exactly; a single missing sentinel makes the whole reply unparseable.
- **Exact-anchor apply failure (13%)**: the SEARCH block must reproduce the target region
  **whitespace-exactly** across multiple lines; any drift → no match → apply fail.
- **No truncation signal**: a cut-off reply is indistinguishable from a malformed one.

## Candidates

| # | Contract | Malformed risk | Apply-fail risk | Truncation detectable | Output size | Multi-file | Verdict |
|---|---|---|---|---|---|---|---|
| A | **JSON unique-anchor edits** (`{"edits":[{"anchor","replacement"}],"done":true}`) | Low — one well-known grammar (JSON); parsers are strict + deterministic | Low — anchors are SHORT unique signatures, not whitespace-exact multi-line blocks; applier fail-closes on 0/>1/overlap | **Yes** — unterminated JSON or missing `done` | Small (anchors + replacements only) | Yes (add `file` per edit) | **RECOMMENDED** |
| B | Unified diff, strict parser | Medium — hunk headers/line counts easy to get wrong | High — context/line-number drift is the classic diff failure; same root cause as v2.2 | Partial | Medium | Yes | Rejected — reproduces the apply-fail mode |
| C | Full target-file replacement + content hash | Low structurally | None (no anchor match) | Yes (hash / line-count check) | **Infeasible** — Black files ~2500 lines ≫ max_tokens 11264 output budget | Poor | Rejected for this arena — output budget |

## Recommendation: Candidate A (JSON unique-anchor edits)

It attacks both dominant failure modes: JSON is a single strict grammar (lower malformed rate,
truncation-detectable via unterminated structure / missing `done`), and a **short unique anchor**
replaces the brittle whitespace-exact multi-line SEARCH block (lower apply-fail). The applier is
fail-closed and all-or-none: 0 matches → APPLY_NOT_FOUND, >1 → AMBIGUOUS, overlap → OVERLAP, and a
partial application can never be written.

## Harness-side feasibility — PROVEN offline

`tools/v3_output_contract_prototype.py` + `tests/test_v3_output_contract_prototype.py` (13 tests)
demonstrate on synthetic fixtures:

```
well-formed parser acceptance   = 100%
ambiguous application rate       = 0
silent partial application       = 0
deterministic replay             = 100%
truncation vs malformed          = distinguished (unterminated / missing 'done' ⇒ TRUNCATED)
multiline + multi-edit           = supported, all-or-none
```

## The half this does NOT settle (needs a paid v3 micro-pilot)

Whether **Haiku reliably emits** this JSON contract is a model-side question. Offline we have only
fixed the parser/applier. Gate A's model-side metric — the real valid-applied-patch rate under the
new contract — requires a small paid micro-pilot (A-condition only, same tasks), gated on a new
budget + pre-registration. The v2.2 raw model responses were not retained per cell (only
classifications), so a pure offline replay of old outputs through the new parser is not possible;
the malformed/apply-fail split (15/4) is taken from the recorded classifications.
