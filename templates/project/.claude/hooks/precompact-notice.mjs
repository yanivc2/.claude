// PreCompact — the last moment to write down anything held only in context.

process.stdout.write(
  JSON.stringify({
    systemMessage:
      'Before compacting: note any open TODOs, architectural decisions, and lessons ' +
      'learned that should be saved to CLAUDE.md or .claude/rules/ before context is ' +
      'lost. Path-scoped rules are dropped by /compact until a matching file is read again.',
  }),
);
