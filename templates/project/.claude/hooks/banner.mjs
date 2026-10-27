// SessionStart — restate the operating rules that have no path-scoped trigger.
// Standalone by design: a seeded project must not depend on files outside it.

process.stdout.write(
  JSON.stringify({
    systemMessage:
      '⚠️ כללים קריטיים:\n' +
      '1. לפני כל התקנת סקיל/הוק — /install-review חובה\n' +
      '2. לא לעשות commit/push ללא בקשה מפורשת\n' +
      '3. הסברים תמיד בעברית',
  }),
);
