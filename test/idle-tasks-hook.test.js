// בעלים 21/10: "בתחילת כל שיחה לאחר יותר משעתיים שלא הייתה פעילה — תן רשימה של משימות שלא סיימנו".
// scripts/idle-tasks-hook.mjs (UserPromptSubmit + `--touch` מ-Stop) — מוסיף את המשימות הפתוחות להקשר רק
// כשעברו יותר משעתיים מהפעילות האחרונה, או כשאין חותמת בכלל (מכולה חדשה = שיחה חדשה). אותו קובץ רץ גם
// בהגדרות האישיות (hooks/ בריפו .claude), ולכן החותמת משותפת ורק אחד מהשניים מדבר.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openTasks, idleContext, IDLE_HOURS } from '../scripts/idle-tasks-hook.mjs';

const SCRIPT = new URL('../scripts/idle-tasks-hook.mjs', import.meta.url).pathname;
const MD = `# משימות פתוחות
## מחכה לפעולה של הבעלים
0. **דוח פדיון מהמייל** (פרטים)
3ה. ✅ **משהו שנסגר** (21/10)
## מחכה לבנק (יתעדכן לבד)
6א. **צילום צ׳ק — שלב 2** (21/10)
## הצעות שטרם הוחלטו
- **רשת ביטחון לילית** (21/10)
## נסגר לאחרונה
- **לא אמור להופיע**
`;

test('open tasks: the bold title of each item in the three open sections; ✅ and "closed recently" are left out', () => {
  assert.deepEqual(openTasks(MD), [
    { section: 'מחכה לפעולה של הבעלים', items: ['דוח פדיון מהמייל'] },
    { section: 'מחכה לבנק', items: ['צילום צ׳ק — שלב 2'] },
    { section: 'הצעות שטרם הוחלטו', items: ['רשת ביטחון לילית'] },
  ]);
  const text = idleContext(MD, 3.4);
  assert.match(text, /אחרי 3 שעות בלי פעילות/);
  assert.match(text, /פתח את התשובה ברשימה קצרה בעברית/);
  assert.doesNotMatch(text, /לא אמור להופיע|משהו שנסגר/);
  assert.equal(IDLE_HOURS, 2);
});

test('speaks only after 2+ idle hours (or with no timestamp), once even when two hooks fire, and --touch only records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-'));
  const tmp = mkdtempSync(join(tmpdir(), 'idle-tmp-')); // TMPDIR של ההוק — חותמת ומנעול
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'משימות-פתוחות.md'), MD);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
    const run = (...args) => execFileSync('node', [SCRIPT, ...args], { env, input: '{}' }).toString();
    const state = join(tmp, 'claude-idle-tasks.json');
    const first = JSON.parse(run());
    assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(first.hookSpecificOutput.additionalContext, /בתחילת שיחה חדשה/);
    assert.equal(run(), '', 'right after — nothing');
    const old = Date.now() - 3 * 3_600_000;
    writeFileSync(state, JSON.stringify({ at: old }));
    assert.match(run(), /אחרי 3 שעות/);
    writeFileSync(state, JSON.stringify({ at: old }));
    assert.equal(run(), '', 'the project hook and the personal hook read the same old stamp — only the first one speaks');
    writeFileSync(state, JSON.stringify({ at: 1 }));
    assert.equal(run('--touch'), '', '--touch never adds context');
    assert.ok(JSON.parse(readFileSync(state, 'utf8')).at > Date.now() - 60_000, '--touch records activity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('wired in .claude/settings.json: UserPromptSubmit runs it, Stop touches it', () => {
  const s = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
  assert.ok(s.hooks.UserPromptSubmit.some((g) => g.hooks.some((h) => /idle-tasks-hook\.mjs"$/.test(h.command))));
  assert.ok(s.hooks.Stop.some((g) => g.hooks.some((h) => /idle-tasks-hook\.mjs" --touch$/.test(h.command))));
});
