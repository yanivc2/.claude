# §2 Pre-Paid Freeze (FROZEN 2026-07-18)

Everything that must be pinned BEFORE the first paid Haiku call, added after the second
consultation review. Bound to: agent contract `S2_AGENT_CONTRACT.md`, family map `4171f399`,
scope `79fae38b`, D `5bd2d42c`, verifier `6gate-v1`, real corpus `s2_real_corpus.json`.
Nothing here changes a prior Decision A–E; it CLOSES the remaining validity holes the review
raised. All items are implemented + tested offline ($0). No paid call has been made.

---

## B1 — parity-optimized derangement (supersedes the fixed rotation) — user decision

B1 must isolate RELEVANCE, not text length / bank occupancy. The single hash-locked rotation
could hand B1 fewer lines/tokens than C on some tasks (B1 → "almost A"). Frozen algorithm
(`experiment/s2/b1_selector.py`, `b1-parity-v1`):

1. After C finishes train and the fold's bank is frozen, enumerate every derangement (no fixed
   point) over the present families.
2. For each held-out family compute what C injects vs what B1 would inject under the mapping.
3. A mapping QUALIFIES iff, for every held-out family: `entries(B1)==entries(C)`,
   `lines(B1)==lines(C)`, and `|tokens(B1)-tokens(C)| ≤ 16` AND `≤ 5%` of `tokens(C)`.
4. Among qualified mappings pick: min(max token diff) → min(sum token diffs) → lexicographic
   tie-break on `sorted(mapping.items())`.
5. If NONE qualifies → the fold is **BLOCKED before any held-out call**. No padding, duplication,
   truncation, or fallback to A.
6. Emit a per-fold artifact hash-locked to the frozen C bank (bank hash, algo version, token-fn
   name, chosen mapping, per-family entries/lines/tokens, content hash).

Computed from the frozen bank + text structure ONLY — never from held-out outcomes / the effect
table. The old rotation stays as a historical artifact but is NOT the active mapping. The token
function is injectable: the pilot passes the SAME `count_tokens` used for the context-cap
preflight; offline tests use a deterministic local proxy (`local-v1`).

## Execution order — counterbalancing (`experiment/s2/ordering.py`, `latin-square-v1`)

- **Condition order:** each held-out task runs A/C/D/B1 in a deterministic per-task rotation
  (stable SHA-256 of the task id), so conditions are balanced across positions and no condition
  is systematically correlated with provider load / time drift. Outcome-independent.
- **Curriculum order:** C's train tasks are learned in one frozen order (`train_order` = sorted).
  The experiment therefore estimates performance under that single frozen curriculum (documented,
  not hidden) — one learning replicate.

## Infra-error policy (frozen, condition-blind)

`run_public_tests` is four-state: `PASS / FAIL / NO_PUBLIC_TESTS / INFRA_ERROR`.
- Round 2 opens ONLY on a genuine behavioural `FAIL`.
- `NO_PUBLIC_TESTS` is not a fail — the hidden verifier still decides correctness.
- `INFRA_ERROR` is NEVER recorded as a condition-specific solver FAIL. `RETRY_POLICY`: ≤2 retries,
  condition-blind, same frozen request; if unresolved the task's **paired comparison is withheld**
  (`classify_attempt_outcome` → `incomplete`), never counted against a condition.

## Held-out request parity (`experiment/s2/prompt.py`)

The real held-out prompt is byte-identical across A/C/D/B1 except the bytes inside the
`<memory>…</memory>` region, and carries **no** family name, condition name, or placebo hint.
The `@@MEM kind=…` tag (used by the offline routing double to verify delivery) is a TEST affordance
and MUST NOT reach a real model — `render_memory_payload` emits label-free bullets only.
Verified by `test_s2_prepaid` (masked requests collapse to one; `prompt_carries_condition_label`
is False for all four).

## Production request path (`experiment/s2/model_client.py`)

`S2ModelClient` is the single call path the pilot uses; it builds the body ONLY via the frozen
contract builder, does not fall back (`ModelUnavailableError`), and surfaces a model mismatch.
- Offline: a recording client proves the exact kwargs + serialized JSON omit
  `effort/temperature/top_p/top_k` and pin snapshot + `budget_tokens=1024`.
- **Required in the pilot environment (where the `anthropic` SDK is installed + version-pinned):**
  run `test_s2_prepaid::test_sdk_serialized_body_omits_effort_and_temperature` (skipped offline,
  it uses an httpx `MockTransport` to inspect the SDK's OWN serialized HTTP body). Record the
  pinned `anthropic` SDK version + httpx version alongside the run. This is the true close of
  P0.1; do not authorize fold 1 until it passes green in the pilot env.

## Learning output asymmetry (worry c — resolved)

C proposing a candidate lesson on TRAIN is part of the learning MECHANISM, not a held-out
confound (A/D/B1 are controls for the PRODUCT of learning, not its cost). Do NOT force A/D/B1 to
emit meaningless train text. Frozen: train-response schema; patch-correctness is independent of
lesson validity (valid patch + missing/invalid lesson → task may pass, no lesson written); C's
train cost is recorded separately and folded into `total cost per held-out verified success`.
Never compare train-task repair accuracy across conditions as an outcome.

## count_tokens context-cap preflight (spec — the next $0 step)

Count WORST-CASE requests, not only the initial 27×4:
- **Round 1:** system prompt + tool schemas + target source file(s) + statement + **maximum legal
  memory-slot payload** + response schema.
- **Worst-case Round 2:** Round 1 + maximum legal Round-1 assistant output + applied patch/tool
  transcript + maximum sanitized public summary + tool-result wrappers.

```
estimated_max = max(count_tokens(all legal Round-1 and Round-2 requests))
headroom      = max(2048, ceil(0.10 × estimated_max))
context_cap   = round_up(estimated_max + headroom, 1024)
assert context_cap + max_tokens(4096) ≤ model_total_context(200_000)
```

`context_cap` is an INPUT-token cap; the 4096 output allowance is reserved separately. At runtime
pre-count every real call; a request over the cap **fails loudly** (no opportunistic truncation).
Because the real C bank does not exist at preflight, count with a maximum-size LEGAL memory slot.

## Exclusion, not truncation (target source)

For target source files: (1) raise the cap if the full task fits the model context; else
(2) **pre-exclude** the task by a frozen token criterion BEFORE any outcome is seen, then re-freeze
the manifest and re-check folds + train-family representation + all hashes. NEVER truncate target
source to keep n=27 (truncation can delete the bug or change difficulty by family). Deterministic
truncation is allowed ONLY for non-semantic bounded fields (public-test output, logs, tool
diagnostics).

---

## Two separate pilot gates (user decision — the paid pilot is NOT one approval)

The real B1 mapping cannot be computed before the first paid call, because C's real bank does not
exist until the 18 paid train tasks run. So authorization is split:

**Gate 1 — before paid C-training**
- all offline tests pass; the SDK-serialized-body test passes with **0 skipped / 0 failed**;
  `max_retries=0` proven on the production path;
- real `count_tokens` sets `context_cap` from the maximum legal complete requests;
- all hashes/config match; budget covers C-training + margin.

**Gate 2 — after C-training, before held-out**
- C's bank is frozen; the B1 mapping is **recomputed with real `count_tokens` on the COMPLETE
  requests**; a qualifying derangement exists (entries+lines parity, token diff ≤16 & ≤5%);
- the per-fold B1 artifact is hash-locked to the bank and tagged
  `token_count_source="anthropic_count_tokens"`;
- remaining budget covers the whole planned held-out block;
- **no qualifying mapping ⇒ STOP the experiment** — no partial held-out, no dropping B1, no
  B1→A, no re-version of the fold in isolation.

## Proxy artifacts are never production-valid (user rule 2)

Every token count carries a `token_count_source`. The offline proxy (`offline_proxy`) is for
**algorithm checks only**; `assert_production_valid` rejects it. A proxy artifact can NEVER freeze
a live `context_cap`, select a live B1 mapping, or open Gate 1 / Gate 2 — only a real
`anthropic_count_tokens` artifact can, and it records model snapshot, request hash, API version,
and prompt/tool/bank/mapping/round in its cache key.

## Reps: primary vs stability roles (user rule 3)

Six sessions per held-out task, in TWO blocks, never pooled:
- **Primary (counterbalanced four-condition block):** A-primary, C-primary, D, B1 — the ONLY runs
  in the C-vs-A / C-vs-B1 / C-vs-D effect estimates.
- **Stability (separate block):** A-stability, C-stability — used ONLY to assess A/C rep-to-rep
  stability; A/C order alternated across tasks; task order frozen; results not exposed until the
  block completes.
Forbidden: pooling the two A/C reps against one B1/D obs without a frozen estimand; picking the
"better" A/C replicate; using one replicate for C-vs-A and another for C-vs-D; relabelling a
stability run as primary after seeing outcomes.

## Infra vs solver taxonomy (frozen, deterministic)

**Solver outcomes (count as solver_fail):** malformed response, refusal, invalid patch, empty
output, max_tokens exceeded, tool misuse, non-compiling patch.
**Infrastructure (→ incomplete, withheld, retried condition-blind):** provider outage, connection
failure before a usable response, sandbox startup failure, verifier crash unrelated to the patch,
api timeout, rate limit. A model-output failure is NEVER laundered into "infra missingness".

## Analysis spec (frozen)

Report separate paired datasets over tasks with BOTH outcomes available: C-vs-A, C-vs-B1, C-vs-D;
plus a complete-block analysis where all four are available. Exact McNemar at small n; effect size
+ per-fold reporting; contamination flags (pre/post cutoff, patch similarity computed AFTER the
run). No threshold / mapping / retry / context rule changes after outcomes are visible. Proxy
artifacts are explicitly not production-valid.

## Correction on the SDK-serialized-body test

`httpx.MockTransport` needs **no API key, no network, no paid call** — only the pinned `anthropic`
+ `httpx` installed. It is $0. This offline env simply lacks the `anthropic` package, so the test
is skipped here; in the pinned pilot env it MUST run green (0 skipped / 0 failed) before any
network call, and it also asserts a retryable status (429/500) produces exactly ONE HTTP request
(`max_retries=0`).

## What remains before authorizing paid fold 1

1. ✅ B1 parity selector on the COMPLETE request + hard block + proxy/production source guard.
2. ✅ Counterbalanced condition order + frozen curriculum order + primary/stability rep roles.
3. ✅ Infra-vs-solver taxonomy + retry policy.
4. ✅ Whole-request parity + label-free prompt.
5. ✅ Response-parser robustness + cross-fold canary + `max_retries=0` (harness owns retries).
6. ✅ count_tokens preflight TOOL built + proxy dry-run (worst-case Round 2, max-legal memory).
7. ⏳ **Pilot env (Gate 1):** SDK-body test green (0 skips) · real count_tokens `context_cap` ·
   real budget check.
8. ⏳ **Pilot env (Gate 2):** real-count B1 mapping per fold, or STOP.
9. ⏳ Optional exact-path paid protocol smoke (FIRST paid call — explicit sign-off; labelled
   protocol-smoke, not pilot data; not reused in fold 1).

## Invalidators (do not start / discard the affected run)

B1 empty/shorter/structurally-different when C is non-empty · condition order correlated with
time · any held-out or other-fold task contributing to C's bank or model-visible state · source
truncated differently or after seeing outcomes · infra errors counted as condition FAILs ·
conditions receiving different schema/tool contract/hidden info · B1 mapping or parity algorithm
changed after outcomes are visible · write-gate seeing hidden-test details beyond PASS/FAIL · a
task excluded because its result looks suspicious rather than by a pre-frozen rule.
