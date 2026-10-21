# AGENTS.md — AP Control (for any AI coding agent)

Instructions for **any** AI coding agent working on this repo (Codex, Cursor, Copilot, Gemini, Claude…).
Claude Code reads [`CLAUDE.md`](CLAUDE.md) automatically; other tools read this file. The rules are the same.

- **Full rulebook:** [`CLAUDE.md`](CLAUDE.md) — read it **entirely** before your first change. Everything below is
  its non-negotiable core, kept here so a tool that never opens CLAUDE.md still cannot break them.
- **Per-feature map:** [`INDEX.md`](INDEX.md) — what each button/route does, what it is coupled to, and what breaks if
  you delete/change/move it. Read the relevant section **before** touching a feature.
- `agent/` in this repo is the **office-PC bank-sync agent** (a Node program that logs into the bank) — it is not an
  AI agent and this file is not about it.

## What this app is
Hebrew RTL, server-rendered accounts-payable app for a small retail group: suppliers, invoices, payments/checks,
Z-reports, register closings, deposits, bank reconciliation, employees. Node ESM + Express 4 + EJS, PWA, no client
framework. SQLite locally/tests, Postgres (Neon) in production. **Live:** https://ap-control.vercel.app

## Non-negotiables
1. **Everything written to the user is in Hebrew** — replies, questions, plans, summaries. Code, identifiers and commit
   messages stay in English.
2. **🔴 כלל ברזל — never guess where a UI element goes.** If a request does not say *where* a new button/element sits
   (or where an existing one moves), ask the owner first, with the real options on screen. Do not pick a "reasonable"
   spot yourself.
3. **Deploy = push to `apnew/main`** (github.com/yanivc2/ap-control; Vercel deploys it):
   `git fetch apnew main && git rebase apnew/main` → `git push apnew ap-control-split:main` → mirror
   `git push origin ap-control-split`. Never force-overwrite another session's commits.
4. **Bump `BUILD_VERSION`** in `src/app.js` on every deploy and verify it on the live login page footer.
5. **Before every push, all green:** `npm test` (SQLite) **and** `TEST_PG=1 npm test` (Postgres dialect) **and**
   `node scripts/smoke.mjs` **and** `node scripts/doc-check.mjs`. A new GET route must be added to the smoke list by hand.
6. **Schema lives in 3 places** — `src/db/schema.sql`, `src/db/migrate.js`, `src/db/schema.pg.sql` (CREATE + bottom
   `ALTER … ADD COLUMN IF NOT EXISTS`). After any schema change tell the owner to click **הגדרות → "עדכן מסד נתונים"**.
   You have no access to the live DB.
7. **Money is integer agorot** (₪1 = 100). "Today" = `israelToday()`, never `new Date().toISOString()`.
8. **Every POST ends in a 303 redirect** (Post/Redirect/Get) — never `render` from a POST.
9. **Store/company isolation is enforced:** every write of a `store_id` from the request goes through
   `assertStoreAllowed(storeId, req.scope)`; lists use `scopeWhere`/`scopeClause` with `req.scope`; by-id access uses
   `assertInScope`. Entry forms never get a store picker or a visible store field (`partials/_formStore.ejs` = hidden fields only).
10. **An alert that must not be lost is `await notify(...)`** — on serverless an un-awaited one can vanish.
11. **Secrets never enter the repo or the DB:** bank passwords live only in `agent/config.json` on the office PC
    (gitignored); tokens/keys are Vercel env vars. Never print, commit or request them.
12. **All page text is centered with `!important`** (`src/public/nocturne.css`, end of file — owner's decision). A local
    `text-align` will not apply; a different alignment is an explicit exception placed after that block.
13. **Profitability sales come ONLY from the nightly revenue report ("דוח פדיון")** — never fall back to Z totals
    (owner's decision: a Z is not closed every day, so a week/month cut through it is wrong). A day with no report is
    listed as missing, so it can be re-issued at the till. `services/reports.js#profitability`.
14. **🔴 No leakage between bank accounts (owner's iron rule, 21/10).** A file/manual bank row that the bank already
    lists in ANOTHER account (same 5+-digit reference, amount, ±3 days), or a debit that is another account's check,
    is refused (`services/bankTransactions.js#foreignRowsFor`; a mostly-foreign file is refused whole). A check is
    auto-matched only when number AND amount agree; amount alone is a suggestion for the owner to approve or
    reject ("✕ דחה" → `bank_match_rejections`; a rejected check is never offered to that line again). The same
    check number + amount in two accounts raises a push + dashboard alert (`services/checkTwins.js`).
15. **🔴 One app per session, never mixed (owner, 21/10).** Another app's repository attached to an AP Control session
    (`israeli-hr-system`, `storemanagement`, `shifts`) is not written, committed or pushed from that session, and no code,
    files or data travel between them or into `ap-control`. Each app is worked on in its own session, under its own rules.

## Keeping the docs true
After any change to a feature/button/route/view/schema: update the matching section of `INDEX.md`; update `CLAUDE.md`
only if a standing rule changed — and if that rule is one of the non-negotiables above, update **this file** too.
Then run `node scripts/doc-check.mjs` (it fails if a load-bearing rule disappears from either file).
