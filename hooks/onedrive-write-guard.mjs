#!/usr/bin/env node
// PreToolUse hook (Write|Edit|NotebookEdit): the iron rule that OneDrive is
// read-only. Files On-Demand placeholders are zero-byte, so writing one severs
// it from its content — reading is fine, writing is not.
//
// Windows-only by nature: OneDrive's local path is a Windows construct here, so
// on any other platform the hook no-ops instead of guessing at a path.
//
// Denies by printing the documented PreToolUse decision and exiting 0. This
// refuses the single write and lets the session carry on, so Claude can write
// somewhere else; the earlier {"continue":false} form halted the whole session.
// Any internal error exits 0 with no output — a broken guard must never block.
//
// Registered in settings.json under hooks.PreToolUse.

import { readFileSync } from 'node:fs';

const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};

try {
  if (process.platform !== 'win32') process.exit(0);

  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const input = payload.tool_input || {};
  // Write/Edit use file_path; NotebookEdit uses notebook_path.
  const paths = [input.file_path, input.notebook_path]
    .filter((v) => typeof v === 'string' && v.length > 0);

  for (const p of paths) {
    if (/[\\/]OneDrive/i.test(p)) {
      deny(
        'BLOCKED: OneDrive is read-only (iron rule) — reading is allowed, ' +
        'writing, moving, renaming and deleting are not. Files On-Demand ' +
        'placeholders are zero-byte, so writing one severs it from its ' +
        `content. Path: ${p}`
      );
    }
  }
} catch {
  // fail open
}
process.exit(0);
