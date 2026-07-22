# §2 Fold-1 Post-Hoc Diagnostic — Findings (EXPLORATORY)

Exploratory analysis of **why C did not help**. Official primary result UNCHANGED
(Δ(C−A)=−0.25, NEGATIVE_DIRECTION, two-sided p=0.625). No cell rerun, no outcome reclassified,
no exclusion added, no bank change. Mechanical counts: `analysis/diagnostic.json`.

## Headline

**The failure is apparatus-dominated, not memory-harm.** 19 of 32 primary cells (59%) never
produced a valid applied patch (15 malformed SEARCH/REPLACE outputs + 4 apply failures). Only 13
cells reached grading with a valid patch; of those, 8/13 (~62%) passed the hidden test. The
memory signal could not surface because most cells never reached a gradeable state — and every
C-vs-A loss is a "C emitted no parseable patch" event, not a "C followed a bad lesson" event.

## 3. Per-task diagnostic table (primary cells; S=hidden pass, and failure mode)

| task | family | A | C | D | B1 | C-vs-A | C injected | note |
|---|---|---|---|---|---|---|---|---|
| black-133 | iterator | malformed | **S** | malformed | S | C_ONLY_WIN | cand-f0b1e78791 | C win = A was malformed (format flip) |
| black-1632 | whitespace | valid→hidden-fail | valid→hidden-fail | valid→hidden-fail | valid→hidden-fail | BOTH_FAILED | 2 whitespace lessons | all 4 superficial patches |
| black-183 | parser_norm | **S** | malformed | S | malformed | A_ONLY_WIN | EMPTY SLOT (C==A) | C loss = pure noise; C had NO memory |
| black-234 | iterator | **S** | malformed | malformed | malformed | A_ONLY_WIN | cand-f0b1e78791 | C loss = malformed output, not bad lesson |
| black-329 | whitespace | malformed | valid→hidden-fail | malformed | malformed | BOTH_FAILED | 2 whitespace lessons | C did produce a (superficial) patch |
| black-60 | whitespace | malformed | apply-fail (R2) | **S** | malformed | BOTH_FAILED | 2 whitespace lessons | D only win |
| black-74 | other_logic | apply-fail (R2) | malformed | apply-fail (R2) | apply-fail (R2) | BOTH_FAILED | 2 other_logic lessons | nobody produced a valid patch |
| black-95 | iterator | **S** | malformed | malformed | S | A_ONLY_WIN | cand-f0b1e78791 | C loss = malformed output, not bad lesson |

Discordant C-vs-A = 4 (1 C-only, 3 A-only). **All 3 A-only wins are C producing malformed
output while A produced a valid patch — and one of them (black-183) had NO memory in C at all**,
proving these flips are stochastic output-format failures, not memory harm.

## 4. Per-lesson quality table

| lesson | family | source | correctness | relevance to held-out targets | verdict |
|---|---|---|---|---|---|
| cand-e04f0fb979 | whitespace | black-112 | true but hyper-specific ("remove stray debug print in tokenizer") | black-1632/329/60 | GENERIC_ONLY→IRRELEVANT (a one-off bug, not a whitespace pattern) |
| cand-23d8aeb211 | whitespace | black-215 | true (multiline-string invisible parens) | black-1632/329/60 | PARTIALLY_RELEVANT at best; different specifics |
| cand-f0b1e78791 | iterator | black-193 | true (for-else var-scope / ParseError) | black-133/234/95 | PARTIALLY_RELEVANT; coarse family match, not the same bug |
| cand-5f96357fce | other_logic | black-130 | true (use full path not filename) | black-74 | IRRELEVANT to black-74's mechanism |
| cand-773d0aca18 | other_logic | black-185 | true (no trailing comma in from-import) | black-74 | IRRELEVANT to black-74's mechanism |
| cand-7542d41466 | boundary | black-224 | true (fmt:off normalization) | — | UNUSED (no boundary task after cookiecutter-18 excluded) |

The lessons are **correct** but are **single-solve artifacts**: each describes the exact code
path of ONE source bug. None is `DIRECTLY_RELEVANT` to any held-out task. The fingerprint-based
family taxonomy is **too coarse** to route a single-bug lesson to a genuinely similar bug.
Truncation was not the problem (lessons rendered within budget); specificity and routing were.

## 5. Failure-mode summary (32 primary cells)

```
MALFORMED_OUTPUT        15   (47%)  — model output not parseable as SEARCH/REPLACE
PATCH_APPLY_FAIL         4   (13%)  — parsed but exact SEARCH anchor did not match
  → no valid applied patch: 19 / 32 (59%)
VALID_PATCH_hidden_fail  5   (16%)  — superficial patch: public PASS but hidden FAIL
SOLVED_hidden_pass       8   (25%)  — valid patch, hidden PASS
  → hidden pass | valid patch produced: 8 / 13 (62%)
```

## 6. Apparatus-vs-arena diagnosis

**APPARATUS (dominant):** the v2.2 output contract (two-round SEARCH/REPLACE + a LESSON block +
extended thinking at max_tokens 11264) is too brittle for Haiku on these ~20k-token files — 59%
of cells die at "no valid patch" before grading, so no treatment (memory or otherwise) can
express itself. Compounding bank weaknesses: single-solve lessons, no reference-assisted
distillation, coarse fingerprint routing, families with only 1–2 lessons, sequential
feed-forward capture.

**ARENA (secondary):** 4/8 tasks both-failed and discordant pairs are few — but the arena is NOT
the primary problem: when a valid patch is produced, 62% pass the hidden test, so the tasks DO
let a correct fix pass and DO discriminate. Most of the apparent "high between-run variance" is
the output-format failure, i.e. an apparatus artifact, not genuine task noise.

**No memory-content harm:** there is zero textual evidence of C following a wrong/distracting
lesson into a bad patch. C's deficit is entirely output-format failures in 3 tasks (one of them
memory-free).

## 7. Recommendation — REDESIGN candidate identified → CONDITIONAL v3 (not now)

A plausible, correctable mechanism IS identified, so the door to a v3 is open — but **STOP here**
under the current authorization (no v3 build, no new spend, no folds 2–3). A future v3, if the
operator approves a fresh pre-registration + budget, should materially differ from v2.2:

1. **Robust output contract** — replace brittle SEARCH/REPLACE+thinking with a forgiving path:
   full-file `write_source`, and/or a malformed-output repair retry, to drop the ~59% no-valid-
   patch rate. Without this, no memory effect is observable regardless of memory quality.
2. **Better lessons** — reference-assisted batch distillation (learn from successes AND
   reference-contrasted failures), not single-solve capture; finer routing (sub-family or
   similarity retrieval) instead of coarse fingerprint families.
3. **Confirm the arena** — the 62% hidden-pass-given-valid-patch suggests the arena can expose
   procedural knowledge once the format bottleneck is removed; re-check on a first micro-pilot.
4. **Fresh pre-registration + budget + frozen manifest + separate reporting** — a new
   experiment, never a retrofit of v2.2 or a reuse of this sealed dataset.

Until then the honest standing conclusion is §4 of the final report: the mechanism is engineered
and works, its effectiveness is unproven, and this pilot could not fairly test it because the
output contract destroyed most cells.
