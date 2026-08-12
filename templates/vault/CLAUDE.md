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

Optional cross-tool compatibility: `cmd /c mklink /H AGENTS.md CLAUDE.md`
(hardlink, no admin needed) lets other AI tools read these same instructions.
