# v3 Design Spec (DESIGN ONLY, $0 — no paid calls, no implementation of a paid runner)

v3 is a **separate experiment** born from the v2.2 pilot's root-cause finding: the output contract,
not the memory, dominated outcomes. v3 fixes the measurement apparatus first, and only then re-tests
learning. It reuses none of v2.2's official results, bank, or manifest.

## Design goals (in priority order)

1. **Make the output contract robust** so a valid applied patch is the norm, not the exception.
2. **Separate the solver from the lesson-writer** so lessons are not single-solve self-explanations.
3. **Route memory finely** so a lesson reaches genuinely similar bugs, not a coarse family bucket.
4. Keep every v2.2 safeguard: hidden F2P grading, label-free injection, token parity, single-use
   grants, atomic budget, sealed blinded evaluation, deterministic unseal.

## 1. Robust output contract (see V3_OUTPUT_CONTRACT_COMPARISON.md)

Adopt **JSON unique-anchor edits** (`{"edits":[{"anchor","replacement"}],"done":true}`), with the
fail-closed all-or-none applier prototyped in `tools/v3_output_contract_prototype.py`. Add a
malformed/truncated **repair-retry**: on TRUNCATED/MALFORMED, one bounded re-ask ("your previous
output did not parse; re-emit only the JSON") before declaring a solver failure — counted and
condition-blind. Anchors are short unique signatures; the applier verifies uniqueness.

## 2. Two-stage gating (never conflate "format" with "learning")

- **V3 Gate A — output-contract validity** (no memory): same tasks/prompts, A-condition only,
  old contract vs new contract, metric = valid applied patch rate. Proceed ONLY if the new
  contract materially reduces the diagnosed failure mode (targets in V3_PREREGISTRATION_DRAFT.md).
- **V3 Gate B — learning** (only if Gate A passes): no-memory vs distilled-memory (and D / B1),
  the actual C−A question, on a robust apparatus where cells reach grading.

## 3. Solver / lesson-writer separation

```
solver produces repair  →  hidden verifies repair  →  independent lesson-distiller receives
  { buggy context, verified repair, reference diff, failure/success evidence }
  →  candidate lesson  →  deterministic write-gate (train-only, leak-screened, capped)
```
The distiller is a distinct call/role — a lesson is no longer the solver's own post-hoc
explanation of a single solve. Distill from successes AND reference-contrasted failures.

## 4. Two-tier routing

```
coarse family        : whitespace / parser / iterator / boundary / ...
procedural fingerprint: { syntax context, failure mode, edit shape, relevant AST/code pattern }
```
Retrieval ranks by procedural fingerprint with a conservative fallback to coarse family. **Design
only** in this phase — no embedding training, no bank rebuild, no retriever implementation yet.

## 5. Mini-pilot, not a continuation

v3 = new protocol · new manifest · new apparatus version · new bank · new budget · new
pre-registration. It is NOT Fold-2 of §2. v2.2's sealed dataset is never reused as v3 data.

## Explicit GO / NO-GO recommendation (for the operator)

**Recommendation: conditional GO to a v3 micro-pilot — but only after a new budget is funded and
the Gate-A pre-registration thresholds are frozen.** Rationale: a plausible, correctable failure
mechanism is identified and its harness-side fix is already proven offline (0% ambiguous / 0%
silent-partial / truncation-detectable / deterministic). The remaining unknown (does the model emit
the contract reliably) is exactly what a cheap Gate-A micro-pilot answers before any expensive
learning run. **NO-GO / close the research** if any of: no new budget is available; a Gate-A
micro-pilot fails to move the valid-patch rate materially; or the arena is judged too thin for
procedural memory to matter even with a clean contract. Until a GO with budget, v3 stays
design-only — this spec authorizes no paid call.
