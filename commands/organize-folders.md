---
description: Staged, approval-gated reorganization of Downloads + Documents into an indexed structure with an Obsidian-ready vault
argument-hint: <preflight | vault | scan | index | propose | apply — empty for status>
---

# Safe folder organization — staged

Reorganize the user's personal folders in small, verified, user-approved steps,
and build the vault + INDEX that map the computer. This command runs **only on
the user's Windows machine** — never in a cloud/Linux session. Report
everything to the user in **Hebrew**.

**Requested phase:** $ARGUMENTS

If "$ARGUMENTS" is empty: run the section 1 read-only checks, report which
artifacts already exist (Vault? latest `scan-*.md`? INDEX filled? open
`proposal-*.md`?), recommend the next phase, and stop.

## Iron rules (every phase)

- **OneDrive is absolutely out of bounds.** Never read, move, rename, copy, or
  delete anything under a OneDrive path, and never follow a link or redirected
  folder into one. With Files On-Demand, files on disk are zero-byte
  placeholders; moving one can sever it from its content and destroy the file.
  A path is OneDrive if it starts with `$env:OneDrive` / `$env:OneDriveCommercial`
  or contains a `OneDrive` segment. If any phase reaches such a path — **STOP**
  and report it in Hebrew.
- Writable scope is exactly: the real Downloads path, the real Documents path
  (only if it is **not** OneDrive-redirected), and `C:\Users\yaniv\Vault`.
  Everything else is read-only. **STOP** before any operation that would write
  outside this scope.
- A directory containing `.git`, `node_modules`, `package.json`, `.sln`, or
  `pyproject.toml` is a code directory: it is **never moved or renamed**.
  Propose a junction instead — `cmd /c mklink /J "<link>" "<target>"`
  (junctions are directories-only, no admin needed).
- Nothing executes without an explicit user GO naming item numbers. A vague
  "ok" is not a GO — ask again.
- There are **no hard deletes**. "Delete" always means a staged move into
  `C:\Users\yaniv\Vault\_organize\trash\<YYYY-MM-DD>\`, emptied manually by
  the user later. Never run `Remove-Item` or `rm` on user data.
- "Unused" requires evidence (age, duplicates, user confirmation). Uncertain →
  mark ASK and ask; never trash on a guess.
- Create/edit Hebrew-content files only with the Write/Edit tools — never
  `Set-Content`, `Out-File`, or `>` redirection (Windows PowerShell 5.1 writes
  BOM/UTF-16 and corrupts the vault).
- If anything fails or cannot be verified, say so immediately in Hebrew and
  stop. Never report unverified success.

## 1. preflight — gates (run before any other phase)

- Verify this is the Windows machine: `Test-Path 'C:\Users\yaniv'` must be
  true. If not — **STOP**: this command must not run remotely.
- Resolve the real paths and echo them to the user:
  - Documents: `[Environment]::GetFolderPath('MyDocuments')`.
  - Downloads: registry `HKCU:\...\User Shell Folders`, value
    `{374DE290-123F-4565-9164-39C4925E467B}`; fallback
    `C:\Users\yaniv\Downloads`.
- OneDrive gate — run this on **every** resolved path before anything else:
  if the path starts with `$env:OneDrive`/`$env:OneDriveCommercial` or contains
  a `OneDrive` segment, that root is **out of scope, permanently**. Report it
  in Hebrew, drop it from the scope, and ask the user whether to continue with
  the remaining root(s) only. Never offer to work on it "carefully".
  Also verify `C:\Users\yaniv\Vault` itself is not OneDrive-redirected — if it
  is, **STOP** and ask the user for a different vault location.
- Backup gate: ask the user to confirm a current backup (File History / cloud
  / external drive) covering both roots. **STOP — no mutating phase without a
  confirmed backup.** Files outside git/backup are unrecoverable.
- Confirm the scope in Hebrew (the two roots + the Vault) once per session.
- Recommend `cd C:\Users\yaniv\Vault` for the index/propose/apply phases, so
  any hook-generated `deletions/` backups land inside the vault (gitignored).

## 2. vault — seed the scaffold (only-if-absent)

- `New-Item -ItemType Directory -Force 'C:\Users\yaniv\Vault'`
- `robocopy "$env:USERPROFILE\.claude\templates\vault" "C:\Users\yaniv\Vault" /E /XC /XN /XO`
  — copies only files missing at the destination; nothing is ever overwritten.
  Robocopy exit codes **0–7 are success** (1 = files copied).
- Initialize the safety net: if `C:\Users\yaniv\Vault\.git` does not exist,
  run `git init` there and make an initial commit of the scaffold.
- Verify and report in Hebrew: `.claude\settings.json` exists in the vault
  (its presence defeats the global SessionStart project-seeder, which would
  otherwise overwrite `.mcp.json` and add typecheck hooks), every folder has
  its README.md, `INDEX.md` is present, git is initialized.
- Mention (optional, don't run unasked): `cmd /c mklink /H AGENTS.md CLAUDE.md`
  creates a hardlink so other AI tools read the same instructions.

## 3. scan — read-only inventory

- This phase mutates nothing, except writing its report with the Write tool.
- For each allowed root, inventory to depth 2–3 with `Get-ChildItem`: per
  directory — item count, total size, newest `LastWriteTime`.
- Mark code directories **OUT-OF-BOUNDS (junction candidate only)**; never
  descend into `.git` or `node_modules`.
- Never descend into a OneDrive path. Also skip any junction/symlink whose
  resolved target lands under OneDrive — list it as OUT-OF-BOUNDS and move on.
- Flag: installers (`.exe`/`.msi` in Downloads), archives, files >100MB,
  obvious name-duplicates, empty directories.
- Flag cloud placeholders separately: a file whose attributes include
  `ReparsePoint` or `Offline` is not fully on disk. Never propose moving one —
  list it under "לא נוגעים" in the report.
- Write the report to `C:\Users\yaniv\Vault\_organize\scan-<YYYY-MM-DD>.md`.
  If the Vault does not exist — **STOP** and instruct running phase `vault`.
- Summarize in Hebrew: counts, sizes, code dirs found, oddities.

## 4. index — interview and fill the map

- Read the latest `scan-*.md`; walk through each project-like directory with
  the user in Hebrew: what is it, is it active, which business, where should
  it live?
- Fill `C:\Users\yaniv\Vault\INDEX.md` with the Edit tool: replace the
  `{{DOWNLOADS_REAL_PATH}}` / `{{DOCUMENTS_REAL_PATH}}` / `{{LAST_UPDATED}}`
  placeholders, fill the tables, refresh the folder map, and append a dated
  entry to the changelog section.
- Offer (don't force) filling the `About/*.md` stubs while context is fresh.

## 5. propose — plan only, zero execution

- Write `C:\Users\yaniv\Vault\_organize\proposal-<YYYY-MM-DD>.md`: a numbered
  table — `# | source (full path) | action | target | evidence | risk`, where
  action is one of MOVE / JUNCTION / TRASH / KEEP / ASK.
- Code directories get JUNCTION only. TRASH requires stated evidence and is
  flagged "individual approval required". Anything uncertain is ASK, never
  TRASH.
- No row may have a OneDrive path as its source **or** its target, and no
  cloud placeholder may appear as a source. Re-check every row against the
  OneDrive gate before writing the file.
- **STOP.** End by asking in Hebrew for an explicit GO with item numbers (or
  "הכול"). No execution happens in this phase under any circumstances.

## 6. apply — gated execution

- Gates (all required, else **STOP**): a proposal file exists; an explicit GO
  with item numbers was given in **this** session; the backup was reconfirmed
  this session; `git add -A` + `git commit` ran in the vault before the round;
  cwd is `C:\Users\yaniv\Vault`.
- Work in batches of ≤10 items. Re-run the OneDrive gate on the source and the
  target of every item immediately before touching it — a stale proposal is
  not a licence:
  - MOVE: `Test-Path` the target first — on collision, skip the item and
    report; use `Move-Item` **without `-Force`**. Moves are not backed up by
    any hook — the collision check is the only safety net.
  - TRASH: one item at a time, each re-approved individually, moved into
    `_organize\trash\<YYYY-MM-DD>\`.
  - JUNCTION: verify the link path is free, then
    `cmd /c mklink /J "<link>" "<target>"`.
- After each batch: verify (source gone / target exists / junction resolves),
  show a Hebrew result table, append to
  `_organize\apply-log-<YYYY-MM-DD>.md` (Write/Edit tool), and ask before the
  next batch.
- Any failure → **STOP everything**, report exactly what happened and what was
  verified, and await instructions.
- When the round completes: update `INDEX.md` (folder map + changelog) and
  commit the vault.

## Output contract

Every invocation ends with a Hebrew status block: the phase executed, the
artifacts created/updated (full paths), the verification results, and the
exact next command to run (e.g. `/organize-folders propose`).
