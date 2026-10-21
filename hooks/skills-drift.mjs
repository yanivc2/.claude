#!/usr/bin/env node
// SessionStart hook: compare the tracked skills manifest against what is
// actually installed on this machine, and report the gap.
//
// It never installs, never deletes, never touches the network. It reads a few
// directory listings and one JSON file, so it costs a few milliseconds. Any
// internal error exits 0 silently — a broken hook must never block a session.
//
// Scope note: only ~/.claude/skills is inspected, because that is the only
// place Claude Code loads from. ~/.agents/skills holds copies for Codex,
// Gemini CLI and Antigravity; npx-installed skills are junctioned from there
// into ~/.claude/skills, so counting the latter is both correct and enough.
//
// Registered in settings.json under hooks.SessionStart.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = (msg) => process.stdout.write(JSON.stringify({ systemMessage: msg }));

try {
  const home = homedir();
  const manifestPath = join(home, '.claude', 'skills-manifest.json');
  if (!existsSync(manifestPath)) process.exit(0);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const dirsIn = (p) => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name);
    } catch {
      return [];
    }
  };

  const skillsRoot = join(home, '.claude', 'skills');
  const local = new Set(dirsIn(skillsRoot).filter((n) => n !== 'synced' && !n.startsWith('.')));

  // claude.ai-synced skills live one level deeper, under a bucket id. They
  // arrive on every machine on their own, so they are never drift.
  const synced = new Set();
  for (const bucket of dirsIn(join(skillsRoot, 'synced'))) {
    for (const s of dirsIn(join(skillsRoot, 'synced', bucket))) synced.add(s);
  }

  const wanted = new Map(); // skill -> install command
  for (const src of manifest.sources ?? []) {
    for (const s of src.skills ?? []) wanted.set(s, src.install);
  }
  const ignored = new Set(manifest.ignore?.skills ?? []);

  const missing = [...wanted.keys()].filter(
    (s) => !local.has(s) && !synced.has(s) && !ignored.has(s)
  );
  const unrecorded = [...local].filter(
    (s) => !wanted.has(s) && !synced.has(s) && !ignored.has(s)
  );

  const show = (a) => a.slice(0, 6).join(', ') + (a.length > 6 ? ` ועוד ${a.length - 6}` : '');
  const skills = (n) => (n === 1 ? 'סקיל אחד' : `${n} סקילים`);
  const cmds = (n) => (n === 1 ? 'פקודה אחת' : `${n} פקודות`);

  const lines = [];
  if (missing.length) {
    const c = new Set(missing.map((s) => wanted.get(s))).size;
    lines.push(
      `📥 ${skills(missing.length)} מהמניפסט לא מותקנים כאן: ${show(missing)}. ` +
        `הרץ /skills-sync להתקנה (${cmds(c)}).`
    );
  }
  if (unrecorded.length) {
    lines.push(
      `📤 ${skills(unrecorded.length)} מותקנים כאן ולא רשומים במניפסט: ${show(unrecorded)}. ` +
        `הרץ /skills-record כדי שיגיעו גם למכונה השנייה.`
    );
  }

  if (lines.length) out(lines.join(' | '));
} catch {
  // stay silent
}
process.exit(0);
