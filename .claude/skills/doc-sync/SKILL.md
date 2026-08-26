---
name: doc-sync
description: >
  Keep AP Control's docs in sync automatically. Invoke this WHENEVER you add, change, move, or
  remove any feature / button / route / view / schema column / service in the AP Control app —
  as part of finishing that change, before pushing, without being asked. It updates INDEX.md (the
  per-feature/button map with impact + coupling) and, only when a structural fact changed, CLAUDE.md,
  and keeps CLAUDE.md as short as possible by deferring detail to INDEX.md. Also invoke it when asked
  to trim/shorten CLAUDE.md. Editing these two files must never drop a load-bearing rule or leave a
  claim that doesn't match the code.
---

# doc-sync — keep INDEX.md + CLAUDE.md accurate and minimal, safely

Two docs, two jobs:
- **`INDEX.md`** — the per-feature/button map: what each does, route→service→view wiring, what it's
  coupled to, and **what breaks if you delete/change/move it**, plus the load-bearing invariants.
  *Read before every change; update after every change.* Detailed, exhaustive.
- **`CLAUDE.md`** — always auto-loaded each session. Holds only the **standing operational rules**
  (deploy/branch workflow, multi-session, run&test, core patterns/invariants, auth firewall,
  gotchas) + a pointer to INDEX.md. Kept **as short as possible** — feature detail lives in INDEX.

## When to run (auto — don't wait to be asked)
After you add / change / move / remove any of: a button or UI action, a route, a view, a service
function, a schema column/table, a permission, or a cross-feature coupling. Do it as the last step
of the change, **before the commit/push** — same turn.

## Update procedure

1. **Find the affected INDEX.md row(s).** Update: what it does · route · wiring (service/view) ·
   what it's coupled to · **impact if deleted/changed/moved**. Add a new row for a new feature;
   remove the row for a removed one. If you changed a cross-cutting invariant (schema-in-3-places,
   `RETURNING id`, permission firewall, scan entitlement, footer enhancers, BUILD_VERSION), update
   the **🔴 invariants** table too.
2. **CLAUDE.md — touch only if a STANDING RULE changed** (a new invariant, a new always-needed
   workflow step, a changed test/deploy command). Feature descriptions do **not** go in CLAUDE.md —
   they go in INDEX.md. If CLAUDE.md grew feature prose, move it to INDEX.md and leave a one-line
   pointer.
3. **Verify accuracy (never trust memory):** for every claim you wrote, confirm it against the code
   with grep/read — route exists, function name is real, permission/gate is what you said, FK
   cascade/nullability is correct. Fix any drift.
4. **Verify nothing broke:** run `node scripts/doc-check.mjs` (below). It fails if a load-bearing
   CLAUDE.md section is missing, the INDEX pointer is gone, a referenced file path doesn't exist,
   or markdown tables are malformed. Do not push while it fails.

## 🔒 Safety — never break these when editing the docs
CLAUDE.md is behavioural (auto-loaded). Removing a rule changes how every future session acts.
**Never remove** these sections from CLAUDE.md when trimming (shorten wording, keep the rule):
- Deploy & branch workflow (`apnew/main`, push commands, `BUILD_VERSION`, DB-upgrade reminder)
- Multi-session work (fetch+rebase, no force-overwrite, BUILD_VERSION collisions)
- Run & test (`npm test` + `TEST_PG=1 npm test` + `scripts/smoke.mjs`)
- Core patterns / invariants (dual DB, agorot, **schema in 3 places**, `x.one`→undefined,
  `RETURNING id` on non-`id` PKs, Israel time, footer enhancers)
- Auth/permissions/scope (firewall) · Adding-a-DB-column checklist · Gotchas
- The **pointer to INDEX.md**
When in doubt, keep the rule and trim its wording. It is always safe to move *feature description*
prose out of CLAUDE.md into INDEX.md; it is never safe to drop an operational rule.

## Keeping CLAUDE.md short
Target: only standing rules + a compact "area → files" map + the INDEX pointer. Any time CLAUDE.md
carries per-button/per-feature detail, that detail belongs in INDEX.md. Prefer one-line pointers
("see INDEX.md · <area>") over paragraphs.

## The guard script
`scripts/doc-check.mjs` (committed) enforces the invariants above. Run it after any doc edit and in
the pre-push checklist. It is docs-only — it never touches app behaviour.
