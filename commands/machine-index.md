---
description: Query or refresh the machine index — the map of what exists on this computer and where
argument-hint: <refresh | summary | a query like "path shufersal" or "ext .xlsx" — empty for summary>
---

# Machine index

The machine index is a JSON map of every file on this computer: paths, sizes,
dates, per-location descriptions, businesses, and security findings. It lives at
`C:\Users\yaniv\Vault\_organize\machine-index-<date>.json` and it is **~5 MB**.

**Never open it with the Read tool.** At roughly 1.3 million tokens it would
consume the entire context window several times over. `permissions.deny` blocks
that path on purpose. Query it with `bin/qindex.mjs` instead, which parses the
file in a Node process and prints at most a few dozen rows.

**Request:** $ARGUMENTS

Report findings in **Hebrew**.

## 1. Query (default)

Translate the user's question into one `qindex.mjs` invocation and run it:

```
node C:\Users\yaniv\.claude\bin\qindex.mjs <flags>
```

| The user asks | Flags |
|---|---|
| what's on this machine / how much of what | `--summary` |
| which folders exist, how big | `--locations` |
| where is X | `--path X` |
| all files named like X | `--name "*X*"` |
| every spreadsheet / every `.env` | `--ext .xlsx` |
| what's biggest | `--top 20 --by-size` |
| what changed recently | `--since 2026-08-01` |
| duplicates / wasted space | `--dupes` |
| exposed secrets, risky files | `--security` |

Filters compose: `--path OneDrive --ext .xlsx --since 2026-07-01`.

- Add `--limit N` (max 100) only when the user needs more rows. Default 40 is
  deliberate — a wide query is a context leak.
- If output ends with "... N more", **do not** re-run with a higher limit by
  reflex. Narrow the query, or tell the user how many matched and ask what to
  narrow by.
- If the script reports no index file, run section 2 first.

## 2. refresh — rebuild the index (read-only scan)

Only when the user asks, or the index is older than a month.

- **Read-only.** This phase creates nothing outside `_organize\`, and moves,
  renames, and deletes nothing anywhere. Say so before starting.
- Scope: `C:\`, the user profile, and the drive-root project folders. Skip
  `C:\Windows`, `C:\Program Files*`, and credential stores (`.ssh`, `.docker`,
  `.config\gcloud`, `.claude`).
- Prune while walking: `node_modules`, `.git`, `__pycache__`, `.venv`, `venv`,
  `dist`, `build`, `.next`, `vendor`, `site-packages`, `target`, `coverage`.
- **OneDrive is read-only** — inventory it at directory level (counts, sizes,
  dates) so business material reaches the map, but never open files in bulk:
  each read pulls down a Files On-Demand placeholder.
- Preserve from the previous index, never discard: `businesses`,
  `security_findings`, `changelog`, and any `deleted_*` record. Those are
  hand-curated history the scan cannot regenerate.
- Write `machine-index-<YYYY-MM-DD>.json` as a **new** file; leave the previous
  one in place.
- Then refresh `C:\Users\yaniv\Vault\INDEX.md` from it with the Edit tool —
  paths, project table, folder map, and a dated changelog line.

## 3. Report

Answer the question in Hebrew, in prose, with the numbers that matter — not a
raw dump of the tool output. When a security finding surfaces, state its severity
and what action it needs, and remember that deleting a leaked credential file is
not the same as revoking the credential.

End with the exact command you ran, so the user can re-run it themselves.
