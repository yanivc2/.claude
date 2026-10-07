#!/usr/bin/env node
// Stop hook: "כל טקסט למשתמש בעברית". The rule lives in CLAUDE.md and .claude/settings.json
// ("language": "hebrew"), and replies still slipped into English after long technical stretches —
// so this checks the FINAL reply of every turn and, if it is mostly English, blocks the stop and
// asks for it to be rewritten in Hebrew before it reaches the user.
//
// What counts: the assistant text after the turn's last tool call (the reply itself). Code blocks,
// inline `code`, URLs and paths are stripped first — identifiers stay English by rule. A reply with
// fewer than MIN_LETTERS letters left is not judged. Hebrew share below MIN_HEBREW = block.
//
// Fail-safe like doc-sync-hook.mjs: any internal error allows the stop. Loop guard: at most
// MAX_BLOCKS consecutive blocks per session (a state file in the OS temp dir), then it lets go.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIN_LETTERS = 40;
export const MIN_HEBREW = 0.5;
const MAX_BLOCKS = 2;

/** Hebrew share of the letters in a reply, after removing code, URLs and paths. */
export function hebrewShare(text) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, ' ');
  const he = (clean.match(/[֐-׿]/g) || []).length;
  const en = (clean.match(/[A-Za-z]/g) || []).length;
  return { he, en, total: he + en, share: he + en ? he / (he + en) : 1 };
}

/** The final reply of the current turn: assistant text entries after the last tool call/result. */
export function finalReply(lines) {
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const m = o && o.message;
    if (!m || !Array.isArray(m.content)) {
      if (o && o.type === 'user') break;
      continue;
    }
    if (o.type === 'user') break; // a tool result or the user's own message — the reply starts after it
    if (o.type !== 'assistant') continue;
    if (m.content.some((b) => b && b.type === 'tool_use')) break;
    for (let j = m.content.length - 1; j >= 0; j -= 1) {
      const b = m.content[j];
      if (b && b.type === 'text' && b.text) parts.unshift(b.text);
    }
  }
  return parts.join('\n');
}

function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return; }
  const path = payload.transcript_path;
  if (!path || !existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const reply = finalReply(lines);
  const s = hebrewShare(reply);

  const state = join(tmpdir(), `hebrew-reply-hook-${String(payload.session_id || 'x').replace(/[^\w-]/g, '')}.json`);
  let st = {};
  try { st = JSON.parse(readFileSync(state, 'utf8')) || {}; } catch { st = {}; }
  // The same hook can be configured twice (global ~/.claude settings + a project's). Both run on the
  // same stop: the second repeats the first one's verdict as is — it neither counts nor re-decides.
  const sameStop = st.len === lines.length;
  if (sameStop && !st.blocked) return;
  const count = st.count || 0;
  if (sameStop) { console.log(JSON.stringify(blockMsg(s))); return; }

  if (s.total < MIN_LETTERS || s.share >= MIN_HEBREW || count >= MAX_BLOCKS) {
    try { writeFileSync(state, JSON.stringify({ count: 0, len: lines.length, blocked: false })); } catch { /* ignore */ }
    return;
  }
  try { writeFileSync(state, JSON.stringify({ count: count + 1, len: lines.length, blocked: true })); } catch { /* ignore */ }
  console.log(JSON.stringify(blockMsg(s)));
}

function blockMsg(s) {
  return {
    decision: 'block',
    reason: `התשובה האחרונה נכתבה ברובה באנגלית (${Math.round(s.share * 100)}% עברית). הכלל: כל טקסט `
      + 'למשתמש בעברית — תשובות, עדכונים, שאלות וסיכומים. כתוב את אותה תשובה מחדש, במלואה, בעברית '
      + '(קוד, מזהים ופקודות נשארים באנגלית), בלי להתנצל ובלי להזכיר את הבדיקה הזו.',
  };
}

// pathToFileURL, not `file://${argv[1]}`: on Windows argv[1] is C:\\... and the naive form never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch { /* fail-safe: allow the stop */ }
  process.exit(0);
}
