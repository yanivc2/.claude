// SessionStart — repo-scoped (.claude/settings.json)
//
// Restates the three operating rules at the top of a session spent editing this
// repository's own configuration, where the blast radius is every future
// session on the machine.

import { notify } from './_lib.mjs';

notify(
  '⚠️ כללים קריטיים:\n' +
    '1. לפני כל התקנת סקיל/הוק — /install-review חובה\n' +
    '2. לא לעשות commit/push ללא בקשה מפורשת\n' +
    '3. הסברים תמיד בעברית',
);
