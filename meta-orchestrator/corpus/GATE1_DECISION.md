# GATE 1 — Decision Record (FROZEN)

**GO FOR SCOPED §2.** The corpus is qualified for the harness-supported families. Typing is
excluded due to a harness-origin selection bias and is NOT part of any generalization claim.

Date: 2026-07-16. Basis: `pybughive_report_post_f2p_fix.json`, manifest
`pybughive_gate1_manifest.json` (27 admitted, sha256 `cee0c602…`).

## Scope of the §2 claim (revised)

§2 does **not** test generalization across all Black bug families. It tests learning on the
families the harness reproduces reliably: **whitespace, iterator, parser, boundary,
condition**. **Typing is out of scope** due to a known harness bias (see below).

## Why GO (not another harness round)

- 27 admitted; count far above the 6-task bar; real intra-Logic semantic diversity
  (6 primary sub-families, top 30% — the coarse "Logic 85%" was a measurement artifact).
- 0 regressions across all rounds; 0 bug-specific harness fixes; manifest frozen with a hash
  before any model run; exclusions are independent of A/C/D and of model behavior.
- Chasing "zero gaps" via dynamic-discovery support is high engineering cost, Black-specific,
  regression-prone, and low value while Typing is explicitly out of scope — it would turn the
  qualification layer into a project of its own.

## The Typing bias (honest, material — not "small noise")

The 10 harness-limited exclusions skew to Typing (8/10). Of 9 Typing bugs, only 1 was
admitted; 8 were lost to the harness (dynamic test-data discovery, no stable token to map).
So the admitted corpus is formatting/Logic-heavy **because we can't reproduce Typing**, not
because Typing is rare. The 27 must therefore **not** be presented as representative of the
whole corpus.

## Conditions binding on the §2 run

1. **All 9 Typing bugs are out of scope — including the single admitted one.** (Mechanically
   removing that bug from the manifest → 26 tasks, and re-sealing the hash, is deferred to
   Step 2 by explicit decision; until then the frozen 27-manifest stands with this caveat
   recorded.)
2. **Report §2 results per family**, never only a pooled 27-task aggregate.
3. **Do not promote any playbook rule presented as a Typing rule** on the basis of this corpus.
4. Deferred issue (below).
5. Gate phrasing is exactly: *GO FOR SCOPED §2 — the corpus is qualified for the supported
   families; Typing is excluded due to a harness-origin selection bias and is not included in
   generalization claims.*

## Deferred issue

```
Typing-family harness support
Status: deferred
Reason: dynamic test-data discovery (no stable token to map fixture → consuming test)
Not a blocker for scoped §2
```
