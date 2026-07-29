# P2m — Measured Token Pilot

**Measure, calibrate nothing.** P2m compares three numbers on one small frozen corpus —
the legacy `chars // 4` heuristic (G1), the rules-based Planner estimate, and the real
measured token count — to decide whether the Planner's coefficients point in the right
direction before anyone lets it enforce a budget. It changes no coefficient, enforces
nothing, and opens no PR.

> **Measurement status in this environment: BLOCKED.**
> No API credential is resolvable here (the P2m probe failed: the `anthropic` client
> cannot resolve an authentication method). Per the P2m brief, the pilot does **not**
> fabricate a count. It produced the offline half — legacy vs Planner, for every sample —
> and left the measured column empty. The measured run is a one-command resume once a
> key is available (see §9).

```
planner/measurement/
  corpus.py    the frozen corpus: 7 families × 3 sizes, content-addressed
  entities.py  TokenMeasurement, FamilyAnalysis, CalibrationProposal (doc-only)
  budget.py    PilotBudget — hard USD cap + call ceiling, fail-closed
  counter.py   AnthropicCountTokensCounter — input-only, fail-closed, budget-guarded
  pilot.py     run_pilot — legacy + Planner (offline) + measured (if a counter is given)
  errors.py    fail-closed error taxonomy
data/token_pilot/
  corpus_manifest.json         the frozen corpus, hashed
  results/offline_run.json     this run's offline observations + family analysis
```

---

## 1. Purpose

Answer one question with data: are the Planner's per-family token coefficients roughly
right, usefully conservative, or dangerously wrong — before P2b would let the Planner
stop a run. P2a already showed the legacy heuristic and the Planner disagree; P2m is
about *who is right*, per content family.

## 2. Corpus (§4, §5)

Location: `meta-orchestrator/data/token_pilot/` (product tree — **not** `experiment/s2`).
The samples are literals in `planner/measurement/corpus.py`, so the corpus reproduces
byte-for-byte with no file or network dependency; `corpus_manifest.json` is the hashed
record. Version `token-pilot-corpus-v1`.

Seven families × three sizes = 21 samples: PROSE_LATIN, PROSE_HEBREW, PROSE_MIXED,
SOURCE_CODE, STRUCTURED_DATA, DIFF_PATCH, TOOL_SCHEMA, each at short / medium / long.
Plus two fixed overhead fragments (a system prompt and a tool schema) measured
separately (§16). Every sample is deterministic, content-addressed (full SHA-256),
varied real content (not one repeated character), and carries no secret or personal data
(a test scans for both).

## 3. Model and counting method (§6, §7)

- One model only: **claude-haiku-4-5**, pinned to its dated snapshot
  `claude-haiku-4-5-20251001`. It is the cheaper real catalogue model; the pilot measures
  tokenizer behaviour, not model quality, so the choice is about cost and stability.
- **Input tokens only.** The counter calls `messages.count_tokens` and never
  `messages.create` — no generation, no output, no inference billing. A test asserts only
  `count_tokens` is ever called, and the counter exposes a `generate` method that raises.
- No `count_tokens` over the network happens without a credential; the offline columns
  need none.

## 4. Hard budget (§8)

`PilotBudget`: a hard cap of **USD 1.00** and a **30-call** ceiling, enforced
*before* each call (`authorise_call` raises `PilotBudgetExhaustedError` rather than
overspend). Token counting is not billed as inference, so the per-call cost defaults to
zero — but the ceiling is enforced regardless of that assumption. If the budget is
exhausted mid-run, the remaining samples stay unmeasured and the run records a reason
instead of raising.

## 5. Raw observation schema (§10)

Each `TokenMeasurement` (content-addressed) carries: measurement id, sample id and
content hash; provider, model, counting method; input bytes / code points / words /
lines; content family and script; legacy tokens; Planner best/expected/worst; and — when
measured — measured tokens, request id (tolerated absent), legacy and Planner-expected
absolute and percentage error, whether the measured value fell inside the Planner range,
and code-points-per-token and bytes-per-token ratios. No response headers or metadata are
stored (they could carry secrets); no API key is ever read into a variable, logged, or
written.

## 6. Analysis methodology (§12)

Per family: sample count, median legacy and Planner-expected tokens, and the rate at
which the legacy value falls inside the Planner range (offline). When measured data
exists: median measured tokens, median code-points-per-token, legacy and Planner-expected
median absolute percentage error, Planner interval coverage, under/over-estimation rates,
and the worst under/over-estimation. `FamilyAnalysis.of` computes all of this.

---

## 7. Results — offline half (this environment)

The measured column is BLOCKED, so these are **legacy vs Planner**, not vs ground truth.
They show *divergence and its shape*, not which estimator is correct.

| family | n | legacy median | Planner expected median | legacy inside Planner range |
|---|---|---|---|---|
| prose_latin | 3 | 101 | 102 | **100%** |
| prose_hebrew | 3 | 74 | 175 | 0% |
| prose_mixed | 3 | 65 | 120 | 0% |
| source_code | 3 | 81 | 100 | 0% |
| structured_data | 3 | 67 | 96 | 0% |
| diff_patch | 3 | 135 | 180 | 0% |
| tool_schema | 3 | 116 | 180 | 0% |

**Reading, stated carefully.** On English prose the two agree almost exactly (101 vs 102).
On every other family the Planner estimates materially higher, and the legacy value sits
below the Planner's whole plausible range. This is consistent with the Planner modelling
density differences the heuristic ignores (Hebrew is token-dense; code, JSON, diffs and
schemas tokenize into many small tokens). **But whether the Planner is correctly
conservative or simply over-estimating cannot be known without the measured column** —
that is precisely the question P2m exists to answer, and it is the reason the block
matters rather than being a mere inconvenience.

## 8. Calibration proposal (§14)

**None produced.** A `CalibrationProposal` requires a measured basis, and there is none.
Producing one from the offline divergence would be inferring a coefficient from no ground
truth — exactly what §3 and §14 forbid. The type exists; the pilot leaves it empty until
a measured run exists, and even then it is documentation for a human, never applied.

## 9. Resuming the measured run

When an `ANTHROPIC_API_KEY` is present (and the proxy CA is trusted via `SSL_CERT_FILE`):

```
export ANTHROPIC_API_KEY=...            # not stored, not logged, not committed
export META_ORCH_RUN_TOKEN_PILOT=1
pytest tests/test_planner_measurement.py::test_real_token_count_pilot_opt_in
```

or programmatically:

```python
from meta_orchestrator.planner.measurement import run_pilot, AnthropicCountTokensCounter, PilotBudget
run = run_pilot(now=..., counter=AnthropicCountTokensCounter(budget=PilotBudget()))
```

The counter fails closed if the key is absent; the budget caps the run at USD 1.00 / 30
calls. The measured column and every error/coverage field then populate, and the
family-level findings above gain their measured half.

## 10. Why no output measurement (§17)

Output token measurement is deferred: it requires generation (cost, stopping behaviour,
`max_tokens`), and P1b's output profiles are keyed to artifact type rather than tokenizer
alone. A separate bounded phase (`P2m-out`) can take it up later. Not done here.

## 11. Limitations and bias (§18)

Small corpus; hand-picked samples; one model; one tokenizer; input only; no output; no
production traffic; no long-context extremes; no binary/encoded/image/document input; no
cache measurement; no cross-provider comparison. **This pilot does not prove general
calibration.** Its job is to indicate whether the current coefficients are in the right
direction, usefully conservative, or dangerous — and, in this environment, to deliver the
offline divergence and a ready-to-run measured harness while the credential block stands.

## 12. Assurance

No coefficient, rule, or profile was changed. No enforcement was enabled. The shadow
integration stays non-enforcing. `experiment/s2` and the frozen corpus are untouched. No
generation call was made. No PR was opened and nothing was merged to `main`.
