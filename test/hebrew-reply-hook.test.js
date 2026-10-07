// בדיקת "כל טקסט למשתמש בעברית" (Stop hook): תשובה סופית שרובה אנגלית נחסמת ונכתבת מחדש;
// קוד, נתיבים וכתובות לא נספרים; חסימה עד פעמיים ברצף ואז משחרר (לא נתקע בלולאה).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hebrewShare, finalReply, MIN_HEBREW } from '../scripts/hebrew-reply-hook.mjs';

const line = (type, content) => JSON.stringify({ type, message: { role: type, content } });
const transcript = (finalText) => [
  line('user', [{ type: 'text', text: 'תעשה משהו' }]),
  line('assistant', [{ type: 'text', text: 'Checking the files now.' }]),   // mid-turn note — not judged
  line('assistant', [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
  line('user', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
  line('assistant', [{ type: 'text', text: finalText }]),
];
function run(finalText, session) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrh-'));
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, transcript(finalText).join('\n'));
  return execFileSync('node', ['scripts/hebrew-reply-hook.mjs'], {
    input: JSON.stringify({ transcript_path: p, session_id: session }), encoding: 'utf8',
  }).trim();
}

test('share ignores code, inline code, URLs and paths', () => {
  const s = hebrewShare('הוספתי את `outstandingBankCandidates` ב-src/services/reports.js, ראה https://ap-control.vercel.app/login\n```js\nconst x = 1;\n```');
  assert.ok(s.share > 0.9, `share ${s.share}`);
  assert.ok(hebrewShare('Done and live. All tests pass on both databases.').share < MIN_HEBREW);
});

test('finalReply = the text after the last tool call, not the mid-turn notes', () => {
  assert.equal(finalReply(transcript('התשובה הסופית')), 'התשובה הסופית');
});

test('an English final reply is blocked; a Hebrew one passes; two blocks in a row, then it lets go', () => {
  const sid = `t-${process.pid}-${Date.now()}`;
  const en = 'Done and live (version 212). The inspect page shows what the bank recorded and what the system has.';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrh3-'));
  const p = path.join(dir, 't.jsonl');
  const hook = () => execFileSync('node', ['scripts/hebrew-reply-hook.mjs'], {
    input: JSON.stringify({ transcript_path: p, session_id: sid }), encoding: 'utf8',
  }).trim();
  fs.writeFileSync(p, transcript(en).join('\n'));
  assert.match(hook(), /"decision":"block"/);
  fs.appendFileSync(p, '\n' + line('assistant', [{ type: 'text', text: en }]));   // each stop = a longer transcript
  assert.match(hook(), /"decision":"block"/);
  fs.appendFileSync(p, '\n' + line('assistant', [{ type: 'text', text: en }]));
  assert.equal(hook(), '', 'loop guard: the third consecutive time it allows the stop');
  assert.equal(run('הכול באוויר (גרסה 212), וכל הבדיקות עוברות בשני מסדי הנתונים.', `${sid}-he`), '');
  assert.equal(run('אוקיי', `${sid}-short`), '', 'too short to judge');
});

test('the hook is wired in .claude/settings.json next to doc-sync', () => {
  const cfg = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
  const cmds = cfg.hooks.Stop.flatMap((h) => h.hooks.map((x) => x.command));
  assert.ok(cmds.some((c) => c.includes('scripts/hebrew-reply-hook.mjs')));
  assert.equal(cfg.language, 'hebrew');
});

test('configured twice (global + project) on the same stop: one verdict, counted once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrh2-'));
  const p = path.join(dir, 't.jsonl');
  const en = 'Done and live (version 213). The page shows what the bank recorded and what the system has.';
  const sid = `twice-${process.pid}-${Date.now()}`;
  const once = () => execFileSync('node', ['scripts/hebrew-reply-hook.mjs'], {
    input: JSON.stringify({ transcript_path: p, session_id: sid }), encoding: 'utf8',
  }).trim();
  fs.writeFileSync(p, transcript(en).join('\n'));
  assert.match(once(), /block/); assert.match(once(), /block/);      // stop #1, both copies block
  fs.appendFileSync(p, '\n' + line('assistant', [{ type: 'text', text: en }]));
  assert.match(once(), /block/); assert.match(once(), /block/);      // stop #2 — still only the 2nd block
  fs.appendFileSync(p, '\n' + line('assistant', [{ type: 'text', text: en }]));
  assert.equal(once(), ''); assert.equal(once(), '');                 // stop #3 — the guard lets go
});
