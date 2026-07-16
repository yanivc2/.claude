# GATE 1 — Decision Record (FROZEN)

**GO FOR SCOPED §2.** The corpus is qualified for the black formatting-bug families the
harness reproduces reliably. Reporting and interpretation use the **semantic primary-sub
taxonomy**, not the legacy exception-based fingerprint.

Date: 2026-07-16. Basis: `pybughive_report_post_f2p_fix.json`; manifest
`pybughive_gate1_manifest.json` — **27 admitted, sha256 `cee0c602…`, unchanged** (black-95
retained; see below). No model has run against it.

## Known taxonomy limitation (binding)

> The legacy fingerprint label is **exception-based** (it records the F2P crash type, e.g.
> `TypeError` → "Typing") and is **not used for experimental interpretation**. It is kept only
> for backward compatibility. **All diversity analysis and all §2 reporting use the semantic
> primary-sub taxonomy** (derived from the fix diff: whitespace / iterator / parser /
> boundary / condition_inversion / state_mutation / …).

Rationale: the exception-based label twice produced wrong conclusions — first "Logic 85% → no
diversity" (really 6 semantic families, top 30%), then "Typing family lost to the harness"
(see next section). A measure the experiment already knows is unrepresentative must not drive
decisions.

## Why black-95 stays (the reversed condition)

An earlier condition would have dropped the one admitted "Typing" bug. Inspection showed the
label is a mislabel: **black-95 is a formatting fix** (`# fmt: off` / `ENDMARKER` handling in
the visitor; title *"Error formatting files"*; semantic family iterator/parser). It is
squarely in scope. Dropping it would remove a valid formatting bug on the basis of a label we
know is unreliable. **It is retained; the manifest is unchanged (no re-hash).**

## The exclusions are NOT a "Typing family" (semantic re-check)

The 10 harness-limited exclusions carry mostly the exception-based label "Typing" (8/10), but
their **true semantic families are spread**: iterator 5, other_logic 2, whitespace 1,
state_mutation 1, parser_normalization 1. Titles confirm they are formatting bugs
("unnecessary spaces", "crash on concatenated string", "extra space in kwarg unpacking"). So
the exclusion does **not** distort the corpus toward or against any semantic family — the
admitted 27 and the excluded 10 span the same formatting families.

## Coverage caveat (real, but unbiased)

10 of ~37 installed bugs are unreproducible via the current harness (dynamic test-data
discovery — no stable token to map fixture → consuming test). This is a genuine coverage gap,
but it is **semantically symmetric**, so the admitted 27 are a fair (if incomplete) sample of
black's harness-reproducible formatting bugs.

## Conditions binding on the §2 run

1. **Report §2 by semantic primary-sub family** — never a pooled 27-task aggregate only, and
   never by the legacy exception-based fingerprint.
2. **Do not promote any playbook rule labeled by the legacy fingerprint.**
3. The manifest (27 + `cee0c602…`) is the frozen task set; only these ids enter §2; exclusions
   never participate and never change A/C/D status.
4. Deferred issue (below).

## Deferred issue

```
Typing-family harness support  →  RENAMED: dynamic-test-discovery harness support
Status: deferred
Reason: some black tests discover their data files dynamically (glob), so there is no stable
        token to map fixture → consuming test; 10 bugs are unreproducible for this reason.
Impact: semantically-unbiased coverage gap. Not a blocker for scoped §2.
```
