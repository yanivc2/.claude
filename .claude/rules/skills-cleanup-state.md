# Skills and config: decisions, traps, open items

Loads when a config file in this repo is touched. Finished work is **not**
recorded here — git history has it. What is here is what would cost real time to
re-derive, or what is still wrong.

Last measured 2026-10-24.

## How the skill listing actually works

- Discovery is exactly **one level**: `~/.claude/skills/<name>/SKILL.md`. Topic
  subfolders are not supported. **Symlinks are followed**, which is what lets the
  tree under `~/.agents/skills-tree/` exist at all.
- claude.ai-synced skills sit one level deeper:
  `~/.claude/skills/synced/<bucket-guid>/<name>/SKILL.md`. `synced` is a reserved
  directory name. Writing a path as `skills/<name>/` for a synced skill is a bug.
- `skillOverrides`, per the official table: `on` = name + description shown to
  Claude; `name-only` = name only; `user-invocable-only` = **hidden from Claude**,
  present in the `/` menu; `off` = hidden from both. **No tier stops the file
  being Read** — that is what makes the kits work.
- **`skillOverrides` does not touch skills from installed plugins**, in any key
  form. The docs (code.claude.com/docs/en/skills.md): "Plugin skills are not
  affected by `skillOverrides`. Manage those through `/plugin` instead."
  Verified 2026-10-31 on CLI 2.1.310: with `brainstorming` and then
  `superpowers:brainstorming` at `name-only`, and `context-mode:ctx-search` at
  `user-invocable-only`, all stayed listed with full descriptions. Keys of the
  form `anthropic-skills:<name>` (account-synced) **are** honored — observed,
  not documented. The only plugin-level lever is enabling or disabling the
  whole plugin. The 78 plugin-skill keys were therefore removed from the Windows
  `settings.json` (superpowers 15, design 7, frontend-design 1, vercel 37,
  firecrawl 10, context-mode 8); backup
  `settings.json.bak-prefix-overrides-2026-10-31`. Do not add such keys again.
  The Mac got the same cleanup the same day: 81 bare plugin-skill keys and 18
  dead ones (the caveman set, `context-mode-ops`, and ten firecrawl 1.x names
  that firecrawl 2.x does not ship), with a backup of the same name. Both
  machines now hold 101 keys. The Mac writes account skills as bare names
  (`docs`, `007`), Windows as `anthropic-skills:<name>`.
- `skillListingMaxDescChars` (200 here) caps **each** description, not the total.
  The total is `skillListingBudgetFraction`, default 0.01 = 1% of the window.
- Over budget, Claude Code keeps every name and drops the least-used descriptions.
- `disable-model-invocation: true` in frontmatter is the separate, documented way
  to stop model invocation. Reading such a skill as plain text bypasses it.

## The kits

`design-kit`, `build-kit`, `social-kit`, `remote-kit`: one file per job, naming
what to load, in what order, what *not* to load, and which MCP tools to pull with
`ToolSearch`. Standing cost ~180 tokens for all four. `.gitignore` carries
`!skills/*-kit/` alongside `!skills/*-router/`, since `skills/*` is ignored and
git cannot re-include under an excluded directory.

They supersede the three `*-router` skills, which stay for their fuller
catalogues — but a router and a kit firing on the same word compete, so the
routers belong at `name-only`.

## What the listing costs

Windows: 137 distinct skills load (57 user, 59 synced, 41 from 5 installed
plugins). What Claude is shown is 6,253 chars, **~1,550 tokens** — 15% of the 10k
ceiling. Untiered and uncapped it would be ~10,460.

**The overrides do not apply in a cloud session.** There `HOME=/root` and
`/root/.claude/settings.json` does not exist; this repo loads as a *project*, not
as user settings. Proof: skills set to `off` (`007`, `ad-creative`) still appear
in `/context`, and `docs` at `user-invocable-only` shows ~340 tokens. Skills cost
the full 10k there. Fixing it means writing the overrides into the cloud `HOME`,
which does not survive between sessions.

## Plugins delivered by the account (2026-10-31)

- In **app** sessions `off` does not hide account-delivered skills (51 of 59
  `off`/`user-invocable-only` keys still listed on the Mac), and `name-only` does
  not apply to the app's own plugin copies (`design:*`, `frontend-design`). The
  only lever for those is removing the plugin in the Claude app, Customize →
  Plugins, which applies to every machine and to claude.ai at once.
- In the CLI a local plugin wins over the synced one of the same name:
  `claude plugin list` prints `"design@synced" … not loaded`. Disabling the local
  copy therefore saves nothing on Windows — the synced one loads instead, and that
  one ignores `name-only`. **Kept as-is** for that reason.
- **All account plugins stay installed** — the owner's decision: the kits load
  what a job needs on demand. The known cost is that in app sessions their names,
  and some descriptions, still sit in the listing. Zero uses in `pluginUsage`:
  postiz, superdesign, cowork-plugin-management, design-superpowers, and a
  duplicate marketing copy. Do not propose removing them again without new data.
- **firecrawl disabled on both machines** (`claude plugin disable
  firecrawl@firecrawl`; re-enable with `enable`). Zero calls in 231 transcripts;
  on Windows the 1.0.9 CLI wrapper never had a CLI or key; 2.x on the Mac adds a
  hosted MCP server. Firecrawl has only basic proxies for IL, so local Playwright
  from the 24/7 PC is better for Israeli sites.
- **vercel disabled on both machines** (`claude plugin disable
  vercel@claude-plugins-official`; re-enable with `enable`). 37 skills, ~2,000
  listing tokens per session, zero skill uses in `skillUsage`, and its MCP
  server (`plugin:vercel:vercel`) was never authorized. Since `skillOverrides`
  cannot thin a plugin, disabling it was the only lever. The claude.ai Vercel
  connector is separate and still available. Backup:
  `settings.json.bak-vercel-disable-2026-10-31`.

## Duplicates removed, and the Mac's usage counts (2026-10-31)

- **19 personal skills removed on both machines**, each a copy of one loaded from
  elsewhere, so the name was listed twice. pdf, docx, xlsx, pptx: the account
  delivers them, equal or newer. brainstorming plus 14 other superpowers skills:
  the superpowers plugin ships them, newer. None carried local changes. Staged in
  `~/.claude/trash/2026-10-31-skill-duplicates/`; the manifest dropped the
  `obra/superpowers` source and the four document skills, so `/skills-sync` will
  not bring them back. The kits and `dev-workflow-router` now name
  `superpowers:<name>`. skill-creator is still listed three times (personal,
  account, plugin); not addressed — the personal one is the copy the manifest
  installs.
- **The Mac's `~/.claude.json` `skillUsage` was seeded** with the 35 Windows
  entries, because budget trimming drops the descriptions of the least-used
  skills first and the Mac had no history. Result: all four kits and the eight
  probed skills carry descriptions there (~273 skills listed, ~131 with one).
  It does **not** reach the app's plugin skills on the Mac: those are never
  trimmed and all 76 keep their descriptions. Backup:
  `~/.claude.json.bak-seed-skill-usage-2026-10-31`.
- 21 `skillOverrides` keys that matched no installed skill were dropped on
  Windows: the 7 caveman ones and 14 bare names (`design`, `seo-audit`,
  `read-docs`, `firecrawl*`, `find-leads` and others).

## The two machines are separate

Since 2026-10-22 the Mac's `~/.claude` has **no remote** — 341 commits, local
only, nothing backed up off that machine. Windows pushes to `yanivc2/.claude`.
Nothing syncs in either direction; each carries only its own platform's rules
(Mac: 11 hooks, deny 60, `additionalDirectories=/Users/yanivcohen`. Windows: 12
hooks, deny 57). Differing settings between them is expected, not drift.

## Traps already paid for

- `Get-ChildItem -Directory` hides loose files. 505 `.md` files went unseen
  through several rounds of scanning. Count files too.
- `readdirSync(…, {withFileTypes:true})` + `isDirectory()` is **false for a
  symlink**, and most of `skills/` is symlinks. Test `existsSync(d+'/SKILL.md')`.
- Walking `~/.claude/plugins` counts `marketplaces/` — the clone cache of every
  catalogue ever browsed, which is **not** loaded. Only the `installPath`s in
  `installed_plugins.json` are live. This error inflated a measurement 8×.
- `skills/synced` is one directory holding ~59 skills; a depth-1 count reports it
  as a single skill.
- Matching cleanup rules against *descriptions* gives false positives
  (`azure-mgmt-apicenter` classed as store-management because its description says
  "catalog"). Match names first, descriptions only as a fallback.
- PowerShell 5.1 reads `.ps1` as ANSI, so Hebrew in a script file breaks parsing.
  Write such files with Desktop Commander `write_file` or Node — never
  `Set-Content`, `Out-File` or `>`.
- The Desktop Commander transport strips `$` from PowerShell one-liners, silently
  emptying variables. Write `.mjs` files and run `node <path>`.
- `npx` consumes a surrounding `while read` loop's stdin: one iteration runs while
  success is reported for all. Redirect `</dev/null`.
- Installer output lies. `npx skills add` prints `Failed to install 1` when a
  PromptScript target fails although Claude Code's target succeeded. Verify from
  disk, never from a success message.
- A hook printing valid schema-passing JSON decides **regardless of exit code**.
  `{"continue":false}` halts the entire session; `permissionDecision:"deny"` with
  exit 0 refuses one call. The OneDrive guard was wrongly using the first.

## Claimed here once, and disproved

- *"PR #126 tiered the vercel, firecrawl and context-mode plugin skills."* It
  changed nothing: those were bare `skillOverrides` keys for plugin skills, which
  the setting ignores. The same holds for the superpowers, design and
  frontend-design keys. In app sessions some of those skills show without a
  description only because budget trimming drops them.
- *"Archiving the 505 flat `.md` files saved 6,420 chars of listing."* Wrong. The
  pre-archive debug log proves they never loaded. The real win came from archiving
  1,472 skill **directories**: 245,029 → 35,339 description chars.
- *"31 claude.ai connectors are disabled on Windows."* Wrong. No API key exists
  anywhere, and `claudeAiMcpEverConnected` holds 28 entries.

## Open

1. **The 21st.dev API key is still not rotated.** Six copies, all in gitignored
   backups under `~/.claude/backups/` and `~/.claude.json.bak-mcp-2026-10-21`.
   Repo history is clean — verified across 920 commits and 221,645,319 bytes of
   objects; it was never committed. Rotate at 21st.dev, which invalidates all six
   at once; deleting files first accomplishes nothing.
2. 977 skills sit in `~/.agents/skills` (53.9 MB), invisible to Claude Code.
3. The Mac gets its synced skills from the app's own folder, not
   `~/.claude/skills/synced/`, so nothing in `~/.claude` controls them there.
4. `context-mode` still burns ~8s per startup, never connects, and injects a
   `<context_window_protection>` block into every session via SessionStart.
5. `/design-login` returns HTTP 403 on Windows.
6. The repo's own `.mcp.json` is written in the VS Code schema (`inputs` +
   `servers`) rather than Claude Code's (`mcpServers`), and no debug log ever
   mentions the servers it declares. It appears to be dead config.
