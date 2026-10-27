// PreToolUse: Write | Edit | NotebookEdit
//
// OneDrive is read-only (iron rule). Reading is allowed and triggers a
// Files On-Demand download; writing, moving or renaming severs a placeholder
// from its content, so it is refused here.
//
// This hook is the only real enforcement of that rule: Write() entries in
// permissions.deny are accepted by Claude Code but never checked.

import { readPayload, block, ONEDRIVE } from './_lib.mjs';

const path = readPayload().tool_input?.file_path;

if (path && ONEDRIVE.test(path)) {
  block('BLOCKED: OneDrive is read-only (iron rule) — read is allowed, writing is not');
}

process.exit(0);
