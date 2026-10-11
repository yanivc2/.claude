# Vault — Personal Knowledge Base

This folder is an Obsidian vault and the map of this computer: notes, decisions,
and business context in Markdown. It is **not** a codebase — no builds, no npm,
no typecheck. It is a local git repository: commit before every organization
round (that is the safety net).

## Rules

- Respond to the user in **Hebrew**. Note content is Hebrew; file and folder
  names are English.
- Everything new lands in `Inbox/` first — capture → process → review. Keep
  Inbox near-empty.
- Knowledge lives here; work files (code, assets) stay where they are and are
  linked from `INDEX.md`. Never copy projects into the vault.
- From a vault session, never move/rename/delete anything **outside** this
  folder.
- OneDrive: reading is allowed, **writing is forbidden** — never move, rename,
  edit, or delete anything under a OneDrive path. Files On-Demand placeholders
  are zero-byte on disk, and moving one severs it from its content.
- Code directories are never moved anywhere — logical placement is done with a
  junction only: `cmd /c mklink /J "<link>" "<target>"`.
- Write files UTF-8 without BOM: use the Write/Edit tools, never
  `Set-Content` / `Out-File` / `>` redirection.

## Key files

| File | Purpose |
|---|---|
| `INDEX.md` | The map — what exists and where. Start here. |
| `CONVENTIONS.md` | Naming and filing rules. |
| `About/` | Personal/business context for Claude sessions. |
| `_organize/` | Artifacts of `/organize-folders` runs + `trash/` staging. |

Optional cross-tool compatibility: move these rules into `AGENTS.md` and reduce
this file to the single line `@./AGENTS.md`, so Codex and Gemini read them too.
Not `mklink /H` — editors save by write-and-rename, silently breaking a hardlink.
