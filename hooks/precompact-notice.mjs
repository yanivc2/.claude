// PreCompact
//
// Compaction drops path-scoped rules until a matching file is read again, and
// loses anything that was only held in the conversation. This is the last
// moment to write it down.

import { notify } from './_lib.mjs';

notify(
  'Before compacting: save open TODOs, decisions and lessons to CLAUDE.md or .claude/rules/. ' +
    'Note: path-scoped rules are DROPPED by /compact until a matching file is read again — ' +
    'prefer /clear and restarting in the subdirectory you are working in.',
);
