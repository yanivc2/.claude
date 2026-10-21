# Skills and hooks cleanup — state as of 2026-10-21

Where the skills/hooks overhaul stands, so a later session can resume without
re-deriving it. Loads when a config file in this repo is touched.

## What the end state is meant to be

Two router skills stay visible to Claude with their descriptions. Everything they
point at is `name-only`: Claude is shown the name, pays nothing for a description,
and can still invoke it. Junk is `off`. Skills the user drives by hand stay
`user-invocable-only`.

So: ask for design work -> `design-router` loads on its own -> Claude reads the
row and either runs the skill or names the slash command. Same for
`dev-workflow-router`. Fixed cost: two router descriptions plus ~44 names
(~830 chars), down from 245,029 chars of descriptions.

## Done and verified

- **1,472 skill directories archived.** Description budget 245,029 -> 35,339 chars.
- **505 loose `.md` files archived** out of `skills/` (3.7MB, 501 of them dated
  2026-06-06). `MOVED=505 FAILED=0`. Archive:
  `C:\Users\yaniv\.agents\skills-archive\2026-06-07-bulk-flat-md`.
  `skills/` now holds 63 directories plus `.antigravity-install-manifest.json`.
- **`.gitignore` rewritten** (66 lines). Verified with `git check-ignore`:
  `daemon/` (so `control.key` and `pipe.key` can't be committed),
  `settings.json.bak*`, `settings.json.broken*`, `.next/`,
  `.claude/settings.local.json`, platform and plugin state trees.
  `skills/*` + `!skills/*-router/` leaves only the two routers visible — `skills/`
  cannot be negated directly, which is why it is written that way.
- **Hooks migrated from PowerShell one-liners to Node `.mjs`.** No `"shell"` key
  is left, so the same block works on the Mac. All 12 references checked to exist
  before writing. All 12 smoke-tested: pass. `block-secrets` does block a `.env`
  read (exit 2).
- **`skillOverrides`: 100 keys = 75 distinct skills** (25 covered under both the
  bare name and the `anthropic-skills:` prefix, tiers consistent).
  Final tiers: `off`=48, `name-only`=46, `user-invocable-only`=6.
- **All 44 router targets are `name-only`, zero hidden from Claude.** This was the
  bug: they were all `user-invocable-only`, which the official table defines as
  "Listed to Claude: Hidden", so the routers pointed at skills Claude could not
  invoke. Cost of fixing it: 730 + 102 = 832 chars of names.
- **Both routers carry no override**, so they default to `on` — name and
  description shown to Claude. This is the precondition for the whole design; if a
  router is ever hidden, the mechanism is dead.
- **`skillListingMaxDescChars: 200`** set. It is a per-skill cap (default 1536),
  not a total. The total is `skillListingBudgetFraction`, default 0.01 = 1% of the
  context window.

## Fixed along the way

`hooks/onedrive-write-guard.mjs` blocked by printing `{"continue":false}`, which
halts the entire session rather than refusing one write. Moved to the documented
`permissionDecision: "deny"` form with exit 0: the write is refused, the session
continues, Claude can write elsewhere. Also now reads `notebook_path`, not just
`file_path`. Verified: deny on `OneDrive/`, on `OneDrive - Personal`, and on a
notebook path; no decision on a safe path or empty input.

Note for anyone reading the old code: per the hooks docs, valid schema-passing
JSON on stdout decides regardless of exit code, so the old form did block. It was
heavy-handed, not inert. The docs still say to use `exit 2` to enforce a policy.

## Backups (all in the repo root, all gitignored)

- `settings.json.bak-2026-10-21` — before the skillOverrides work
- `settings.json.bak-hook-2026-10-21` — before registering skills-drift
- `settings.json.bak-hooks-2026-10-21` — before the Node hooks block
- `settings.json.bak-retier-2026-10-21` — before the 42-skill retier
- `settings.json.bak-static-2026-10-21` — before canvas-design/web-artifacts-builder

## Open, and who it is blocked on

1. **Nothing is committed.** 5 modified files and 13 new ones sit on branch
   `fix/settings-encoding-repair`, whose name does not match this work — it wants
   a new branch. Blocked on an explicit request from the user; the repo rule is
   never to commit or push without one.
2. ~~Whether loose `.md` files in `skills/` ever loaded~~ — **settled: they did
   not.** `~/.claude/debug/` holds a `--debug` log from 04:06 on 2026-10-21, which
   predates the archiving, and one from 17:42 after it. Both record the skills-dir
   scan, and both emit exactly the same two decisions:

       [plugins] skipping hidden skills-dir entry '.antigravity-install-manifest.json'
       [plugins] skipping skills-dir entry 'synced'

   Nothing references a bare `.md` path under `skills/` in either log, and neither
   log carries a listing-budget warning. The before and after logs are identical in
   this section, which they would not be if 505 skills had been dropped between
   them.

   Caveat: the scanner logs a decision for specially named entries (dot-prefixed,
   and the reserved `synced`), so a plain `.md` could in principle be skipped with
   no log line. Strong evidence, not proof.

   **So the earlier claim that archiving those files saved 6,420 characters of
   listing was wrong.** It bought disk and repo tidiness. The real context win came
   from archiving the 1,472 skill directories: 245,029 -> 35,339 description chars.
3. **Mac: Claude Code 2.1.306 is installed** at `~/.local/bin/claude` via the
   native installer (`curl -fsSL https://claude.ai/install.sh | bash`), same
   version as Windows. `~/.local/bin` was not on PATH, so `claude` reported
   `command not found` while `~/.local/bin/claude --version` worked. Fix pending:
   add `$HOME/.local/bin` to PATH in `~/.zshrc`, then `claude auth login`.

   **Do not install on the Mac with npm.** Three attempts failed there. The Mac's
   Node is v24.21.0 under nvm, so `npm install -g` lands in
   `~/.nvm/versions/node/<version>/` and disappears when a different version is
   active; `npm ls -g | grep claude` came back empty while npm had reported
   "up to date". The npm package also needs its `postinstall` to link the
   per-platform optional dependency into place, which is the same step that was
   blocked on Windows. The native installer sidesteps nvm entirely. The docs mark
   Native Install as the recommended method on macOS too.

   `hooks/skills-drift.mjs` still has never run in a real cross-machine scenario —
   only in a sandbox with a fake HOME (2 missing detected, synced and ignored
   entries skipped, 1 unrecorded caught). The Node hooks were written to be
   platform-neutral for exactly this. Next step once the Mac is logged in: install
   from `skills-manifest.json` (10 sources, 53 skills) and check the hook fires.

   Desktop Commander's agent is installed on the Mac (app 0.3.0, same as Windows)
   but was offline through this work, so the Mac could only be driven by handing
   the user commands to paste.
4. **Audit items not actioned** (full audit:
   `C:\Users\yaniv\AppData\Local\Temp\config-audit-2026-10-21.md`, 447 lines,
   30 findings): narrow `Edit(C:\Users\yaniv\.claude\*)` and
   `additionalDirectories`; run `/install-review` retroactively on `context-mode`.

## Layout of `skills/` as it actually is (checked, not assumed)

64 entries: 51 symlinks, 11 real skill directories, plus `synced/` and
`.antigravity-install-manifest.json`.

- The 51 symlinks all point into `C:\Users\yaniv\.agents\skills\`. None are
  broken; every one has a `SKILL.md`. `claude plugin validate` does not follow
  symlinks and warns about them, but a real session does follow them.
- The 11 real directories are `design-router`, `dev-workflow-router`,
  `design-taste-frontend`, `high-end-visual-design`, `industrial-brutalist-ui`,
  `minimalist-ui`, `redesign-existing-projects`, `skill-creator`,
  `superpowers-lab`, `web-design-guidelines`, `webapp-testing`.
- 9 of those 11 come from a manifest source with a full `npx skills add` command,
  so they rebuild on a new machine. The 2 routers are deliberately in
  `ignore.skills` and travel in git — which is exactly what `!skills/*-router/`
  in `.gitignore` exists for. Nothing is orphaned.
- `skills-manifest.json`: 10 sources, 53 distinct skills, each source carrying its
  install command. `ignore.skills` holds 10 names.
- `claude plugin validate C:\Users\yaniv\.claude\skills` passes with only the
  symlink warning. CLI is v2.1.296, Node v24.21.0.

## The end-to-end check that is still outstanding

`settings.json` was rewritten three times on 2026-10-21 (overrides, Node hooks,
retier). Its JSON is valid and every field was verified by re-reading from disk,
but nothing has yet confirmed that Claude Code *accepts* it — JSON validity is not
schema validity. The attempt to confirm it with
`claude --debug -p` failed before loading any config:

    Failed to authenticate: OAuth session expired and could not be refreshed

So **the CLI on this machine is logged out.** `.credentials.json` is present
(8,524 bytes, mtime 2026-10-21T04:06Z) but the refresh failed. Log in again, then
re-run the probe, and read the Skills line of `/context` while there — that also
settles the loose-`.md` question in item 2 above.

Confirmed not a version problem: the same error appears on 2.1.306. Only an
interactive login fixes it.

## Two Claude Code installs on this machine (2026-10-21)

`where claude` resolves in this order:

1. `C:\Users\yaniv\.local\bin\claude.exe` — the **native** install, and the one
   that actually runs. Its own files live in `C:\Users\yaniv\.local\share\claude`.
2. `C:\Users\yaniv\AppData\Roaming\npm\claude` — a leftover npm global install.

`npm install -g @anthropic-ai/claude-code` fetched 2.1.306 into the npm path, but
npm's `allowScripts` policy blocked its `postinstall` (`node install.cjs`), which
is what selects the right platform binary. The result is unusable — running it
reports "not compatible with the version of Windows you're running." It does no
harm only because the native install shadows it on PATH.

**Use `claude update`, not npm, to upgrade on this machine.** It went
2.1.296 -> 2.1.306 cleanly, and it warns about the duplicate itself, with the fix:

    npm -g uninstall @anthropic-ai/claude-code

Not yet run — it needs an explicit go-ahead. Also sitting in `.local\bin`:
`claude.exe.old.1792605099784.27076`, 260MB, left by the updater.

## The 21st.dev API key: exposure, measured (2026-10-21)

The key lived in `~/.claude.json` under `mcpServers.magic.env.API_KEY`, 72
characters. Removing the `magic` server took it out of the live file, so every
backup Claude Code writes from now on is free of it.

Scanned for copies by matching the value itself, never printing it:

- **Repository history: clean.** Streamed every object in the object database
  (`git cat-file --batch-all-objects`) across 920 commits and 221,645,319 bytes.
  The key appears in no blob. **It was never committed and never reached GitHub.**
  `.mcp.json`, which is tracked, uses `${input:...}` placeholders rather than
  literal values, which is why.
- **Local disk: 6 copies**, all in backup files, all gitignored:
  - `~/.claude/backups/.claude.json.backup.1792597153055`
  - `~/.claude/backups/.claude.json.backup.1792598057005`
  - `~/.claude/backups/.claude.json.backup.1792601328132`
  - `~/.claude/backups/.claude.json.backup.1792602014606`
  - `~/.claude/backups/.claude.json.backup.1792604330906`
  - `~/.claude.json.bak-mcp-2026-10-21` (written by this session)
- Not in the PowerShell PSReadLine history, not in `~/.claude/debug/`, not
  anywhere under `~/.agents`. 13,383 files scanned; 2 skipped for being over 8MB.

**Rotate at 21st.dev first.** That invalidates all six copies at once; deleting
files before rotating accomplishes nothing. Afterwards the copies are stale and
can go to `trash/` as hygiene. Note that nothing needs the key any more unless the
`magic` MCP server is re-added, so the cleanest end state is not to store it
again at all.

`~/.claude.json.bak-mcp-2026-10-21` is also the only recovery path for the three
removed MCP servers, so keep it until you are sure you want none of them back.

## MCP servers, as of 2026-10-21

Removed from `~/.claude.json` because they never completed a connection in any
recorded session, and each stdio one burned about 8 seconds of startup:
`context7` (abandoned after 8,451ms), `playwright` (8,425ms), `magic`.

Kept: `claude-design`, Anthropic's own Design server. It fails with
`UnauthorizedError` only because the CLI is signed out.

Left alone deliberately: `plugin:design:gmail` and `plugin:design:google calendar`
report "No URL configured". They are malformed entries in the `design` plugin's
own shipped `.mcp.json` (`knowledge-work-plugins/design/1.2.0/.mcp.json`), with
neither a url nor a command. Fixing them means editing the plugin cache, which
the next plugin update overwrites, and they fail instantly rather than timing
out, so they cost nothing but a log line. The same file also declares seven
working HTTP servers: slack, figma, linear, asana, atlassian, notion, intercom.

`plugin:context-mode:context-mode` still burns ~8.1s per startup and never
connects. It comes from the context-mode plugin, which also injects a
`<context_window_protection>` block into every session via SessionStart. Not
addressed yet.

The repo's own `.mcp.json` is written in the VS Code schema (`inputs` + `servers`)
rather than Claude Code's (`mcpServers`), and no debug log ever mentions the
`github` or `21st` servers it declares. **It appears to be dead config.** Decide
whether to convert or delete it.

## Documented facts worth not re-deriving

- `skillOverrides` values: `on` = name + description to Claude, in `/` menu;
  `name-only` = name only to Claude, in `/` menu; `user-invocable-only` = hidden
  from Claude, in `/` menu; `off` = hidden from both. The docs do **not** state
  whether `name-only` lets Claude invoke the skill — that is an inference from
  "Listed to Claude". `disable-model-invocation: true` in frontmatter is the
  separate, documented way to stop model invocation.
- When the listing exceeds budget, Claude Code keeps every skill's name and drops
  the descriptions of the least-used skills first.
- Project skills load from `.claude/skills/` in the launch directory and every
  parent up to the repo root. A subdirectory's `.claude/skills/` loads lazily, the
  first time Claude reads or edits a file in that directory.
- `~/.claude/skills/synced/` is where claude.ai skills land. The
  `<bucket-guid>/<name>/SKILL.md` nesting is real on this machine but is not
  documented anywhere. `synced` is a reserved directory name.
- PowerShell 5.1 reads `.ps1` as ANSI, so Hebrew in a script file breaks parsing.
  Write such files with Desktop Commander `write_file` or Node, never
  `Set-Content` / `Out-File` / `>`.

## Traps already fallen into — do not repeat

- `Get-ChildItem -Directory` hides the loose `.md` files. Every scan used it, so
  505 files went unseen through several rounds. Count files too.
- `skills/synced` is one directory holding ~52 skills. A depth-1 count reports it
  as a single skill and reports the Israeli skills as missing. They are not.
- Matching cleanup rules against skill *descriptions* produces false positives
  (`azure-mgmt-apicenter` was classed as store-management because its description
  says "catalog"). Match names first, descriptions only as a fallback.
