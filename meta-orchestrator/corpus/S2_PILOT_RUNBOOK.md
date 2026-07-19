# §2 Pilot-Environment Runbook (FROZEN 2026-07-19)

The exact ordered checklist from standing up the pinned pilot env through Gate 1 → paid
fold-1 C-training → Gate 2 → held-out. Encoded as executable production logic in
`experiment/s2/pilot.py` (shared by the Gate scripts + tests + the real run — no parallel
re-implementation). **Offline / proxy can never open a gate**: every proxy artifact is
`token_count_source="offline_proxy"` / `production_valid=false`, cannot emit
`AUTHORIZED_FOR_FOLD1_C_TRAINING` or `GATE2_PASSED`, and cannot change the manifest status.
Manifest status transitions are append-only + hash-locked. No API key / auth header / prompt
body / hidden-test datum is ever persisted in an artifact (`assert_no_secrets`).

Budget: **keep < $5** until Gate 1's real cost projection justifies more. If Gate 1 shows fold-1
+ reserve does not fit, request a specific amount from the user BEFORE the first paid call — never
before.

---

## Step 0 — locked Run ID  (`examples/s2_run_manifest.py`, $0 offline)
Build ONE manifest: `run_id`, exact commit, all anchor hashes (corpus / folds / family-map / D /
agent-contract / canonical-request-builder / verifier / sandbox / analysis-spec), budget < $5,
status `UNAUTHORIZED_FOR_MESSAGES`.
- **GO:** every anchor matches the frozen docs; working tree committed.
- **NO-GO:** a hash missing / mismatched, or an uncommitted working file.

## Step 1 — pinned environment
Install from a lockfile: Python, `anthropic`, `httpx`, sandbox/verifier libs, corpus deps. Record
package-lock hash, `pip freeze`, OS/container image, arch, endpoint/base URL, environment hash,
git commit, timestamp. **Never** log the API key.
- **GO:** the env builds reproducibly from scratch. **NO-GO:** any unpinned dep / undocumented
  manual install / mid-run code change.

## Step 2 — full offline suite IN the pinned env
Run the whole suite INCLUDING the two currently-skipped SDK tests. Must prove via the installed
SDK: exact snapshot; `thinking={"type":"enabled","budget_tokens":1024}`; `max_tokens=4096`; NO
effort/temperature/top_p/top_k; `max_retries=0`; a 429/500 under `httpx.MockTransport` → exactly
ONE HTTP request; no fallback/alternate client.
- **GO:** `failed==0 AND skipped==0`. **NO-GO:** a single skip or fail.

## Step 3 — canonical request check
Build sample requests through the one `CanonicalS2Request`; re-confirm the Messages and
count_tokens adapters agree on every semantic field (differ only by `max_tokens`). Save canonical-
builder version/hash, sample serialized hashes, model, tools hash, system/prompt hash.
- **GO:** one builder, no drift. **NO-GO:** the two paths differ.

## Step 4 — real count_tokens → freeze context_cap  (`s2_gate1.py` with an AnthropicTokenCounter)
Count with the exact snapshot, for all 27 tasks: full R1 and worst-case legal R2 (full source
bundles, MAX legal memory slot, tool schemas, response instructions, MAX sanitized public
feedback, MAX prior assistant/tool transcript). `estimated_max = max(all)`;
`headroom = max(2048, ceil(0.10·estimated_max))`; `context_cap = round_up(estimated_max+headroom,
1024)`; assert `context_cap + 4096 ≤ 200000`. **No source truncation.** Every count records
`token_count_source=anthropic_count_tokens`, model snapshot, canonical-request hash, counter/cache
version, API/SDK version, round template, count, timestamp.
- **GO:** every task fits; artifacts are real-source. **NO-GO:** overflow / proxy result / missing
  count / fallback-to-proxy.

## Step 5 — cost projection + Gate 1
From real counts compute max R1 cost, max R2 cost, expected 18-train cost, a Round-2-rate scenario,
≥20–25% reserve, and the balance needed to reach Gate 2. Thinking is billed as output;
`budget_tokens=1024` is the minimum; actuals may vary. Rule: `projected_fold1_cost_with_reserve ≤
available_budget`.
- **GO:** fits under < $5 with reserve → Gate 1 emits a signed artifact and transitions the
  manifest to `AUTHORIZED_FOR_FOLD1_C_TRAINING`. **NO-GO:** do not train; request a specific budget
  increase from the user based on the real counts.
- Also verify at runtime: the snapshot is available and NOT past its retirement date (**confirm the
  retirement date from the official model card here — it is not taken from consultation**).

## Step 6 — first paid call = the de-facto protocol smoke (NO separate paid smoke)
The SDK-body test already proved the wire shape and count_tokens proved key/network/model-id at $0,
so the first fold-1 train call IS the protocol smoke. Frozen rule — distinguish two failures:
- **Protocol / config failure** (400 on request shape, snapshot unavailable, parser mismatch,
  unexpected SDK behaviour, any code edit needed): STOP immediately; the result is NOT data;
  **invalidate Gate 1 and all dependent artifacts**; fix code; re-run the ENTIRE suite; re-run
  count_tokens if the request hash changed; restart fold-1 training from an EMPTY bank.
- **Weak-but-valid model response** (wrong patch, empty output, malformed structured output,
  invalid lesson, compile failure): a genuine `SOLVER_FAIL` — NOT a smoke failure; do NOT restart.

## Step 7 — run fold-1's 18 train tasks (frozen curriculum order)
Before EVERY call, the runtime guard (`assert_call_allowed`) checks: Gate 1 valid; env + contract
hashes; correct task/fold; `request_tokens ≤ context_cap`; budget ≥ max call exposure; round/attempt
caps; no proxy artifact referenced; no prior-task state. Per call record: fold/task/round, request
hash, Anthropic request id, input/output/thinking tokens, actual cost, latency, stop reason,
exception category, patch hash, public result, hidden verdict, candidate-lesson hash, every
write-gate decision + reason, bank hash before/after. F2P stays verifier-only; the model never
sees it. Gate 2 may start ONLY if **18/18 train tasks are terminal PASS or terminal SOLVER_FAIL and
unresolved INFRA_ERROR == 0** (not all need to pass — all need a non-infra terminal outcome). Then
freeze the bank: immutable, per-lesson provenance, train-only, fold-local, content-hashed, writes
disabled.

## Step 8 — Gate 2: build the REAL B1 mapping  (`s2_gate2.py` with an AnthropicTokenCounter)
Do NOT reuse or "validate" the proxy pick — start selection from scratch. For each held-out task ×
candidate family: build the complete C and B1 requests, count with `anthropic_count_tokens`, check
entries/lines/tokens; enumerate all derangements; apply the frozen tie-break. Per-task granularity
(source + surrounding text differ across tasks). Gate 2 passes only if, for all 9 tasks: no fixed
point; equal entries; equal lines; token diff ≤16 AND ≤5%; mapping bound to the bank hash AND the
request-builder hash; all counts real-source; every held-out R1 and R2 template fits `context_cap`;
budget covers the whole held-out block with reserve.
- **NO-GO** (no qualifying mapping / missing count / stale bank / overflow / budget): **STOP the
  WHOLE experiment before any held-out call** — not one fold, not just B1.

## Step 9 — fold-1 held-out
Per task: **primary block** A-primary, C-primary, D, B1 in the frozen Latin-square order; **stability
block** A-stability, C-stability in a frozen alternating order. Never pool the two A/C reps against
one B1/D obs; never pick the "better" replicate; never swap primary↔stability after seeing outcomes;
never reorder by a prior result. Runtime guard before every call. Round 2 opens only after a genuine
`PUBLIC_FAIL`. One hidden verification at the end of each attempt; never fed back.

## Step 10 — end fold-1 + continuation gate
Seal the effect table. Before folds 2–3, expose ONLY: `a_flips`, `c_flips`, `sign_reversed` (as a
gate boolean), verifier/environment determinism, infra failures, actual cost, Round-2 rate,
circuit-breaker status. NEVER expose: how much C won, which tasks C solved, C-vs-B1/D, lesson
effectiveness, the effect table. Continue to folds 2–3 only if the frozen stability gate passes AND
the continuation cost fits the budget with reserve. **Budget point:** likely < $5 suffices for fold
1 but maybe not safely for all three folds with Round 2 + stability reps. After fold 1 the real cost
data exists — if the folds-2–3 projection with reserve exceeds the balance, that is when to request
a budget increase (not before).

---

## Comparison invalidators (any ⇒ stop / discard the affected run)
Starting with skipped tests · a model alias instead of the frozen snapshot · a hidden SDK retry ·
a code change after the first paid call with prior data retained · a proxy count used for
context_cap or B1 · a cap overflow silently truncated · a bank that is not 18/18 terminal train ·
a B1 mapping selected from outcomes or R2 trajectories · a held-out call before Gate 2 · a hidden
result reaching the model or lesson text · invalid pooling of stability reps · a continuation
decision based on the effect direction · continuing two folds after the third is B1-blocked · a
budget change bundled with a mid-run agent-contract change.

## Final recommendation (adopted)
Move to the pinned pilot env; run steps 0–5 at $0; authorize the first paid call ONLY after the
Gate 1 report. No separate paid protocol smoke under the current budget.
