# §2 Apparatus v2.2 — Final Closeout (ARCHIVE)

```
V2.2_STATUS        = PILOT_COMPLETE
OFFICIAL_RESULT    = NEGATIVE_DIRECTION_NOT_SIGNIFICANT   (Δ(C−A)=-0.25, two-sided p=0.625, n=8)
FURTHER_V2.2_FOLDS = NOT_PLANNED
OFFICIAL_BANK      = READ_ONLY      (s2_fold1_c_bank.frozen.json, content_hash 513d63007784)
OFFICIAL_RESULTS   = IMMUTABLE      (sealed_outcomes.jsonl sha256 53dec53d…, analysis 2ac09c69…)
```

v2.2 is archived. Its Fold-1 directional pilot is complete and its results are frozen. No further
v2.2 folds are planned; the v2.2 bank and the recorded outcomes are read-only and will not be
retroactively edited, "corrected", or reinterpreted to imply success. Any further work happens as
a SEPARATE v3 experiment (new protocol, manifest, apparatus version, bank, budget,
pre-registration) — never a Fold-2 of §2.

**What the pilot established (see S2_FOLD1_PILOT_FINAL_REPORT.md + the post-hoc diagnostic):**

```
Engineering pipeline works                    YES
Memory retrieval / injection works            YES
Hidden evaluation + sealing work              YES
Positive memory benefit                       NOT SHOWN
Evidence memory content caused harm           NO
Output-contract noise dominated results       YES  (19/32 primary cells → no valid applied patch)
Correctable redesign candidate identified     YES
```

The negative signal is not good evidence of memory harm: black-183, where C carried NO memory
(empty slot), still produced malformed output while A succeeded — the flips are stochastic
output-format failures, not lesson-driven mistakes.

**Frozen v2.2 artifacts (do not modify):** s2_fold1_c_bank.frozen.json,
s2_official_training_log.json, s2_paid_spend_ledger.json, s2_fold1_eval/ (manifest, anchor,
grants, sealed_outcomes, analysis), S2_FOLD1_BLINDED_ANALYSIS_PLAN.md, S2_HELDOUT_EVAL_PROTOCOL.md,
S2_APPARATUS_V2.2_LIMITATIONS.md.

Next: `V3_DESIGN_SPEC.md` — design-only, $0, no paid calls until a new pre-registration + budget
are approved.
