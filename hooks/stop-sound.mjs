#!/usr/bin/env node
// Stop hook: a short chime when a turn ends, so a long run can be left alone.
//
// Replaces the python/winsound one-liner. The player is the only part that has
// to differ per OS, so it is the only part that branches:
//   win32  — the stock tada.wav through .NET SoundPlayer
//   darwin — the stock Glass.aiff through afplay
//   else   — nothing to play, so nothing happens
// The child is detached and unref'd: the chime plays while the session moves on
// (the python version blocked until the sound finished).
//
// Prints nothing on stdout — a Stop hook's stdout is parsed as JSON.
// Any internal error exits 0 silently — a broken hook must never block a session.
//
// Registered in settings.json under hooks.Stop.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

try {
  let cmd = null;
  let args = [];

  if (process.platform === 'win32') {
    const wav = 'C:\\Windows\\Media\\tada.wav';
    if (existsSync(wav)) {
      cmd = 'powershell';
      args = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object Media.SoundPlayer '${wav}').PlaySync()`,
      ];
    }
  } else if (process.platform === 'darwin') {
    const aiff = '/System/Library/Sounds/Glass.aiff';
    if (existsSync(aiff)) {
      cmd = 'afplay';
      args = [aiff];
    }
  }

  if (cmd) {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); // no player, wrong PATH — not worth a word
    child.unref();
  }
} catch {
  // stay silent
}
process.exit(0);
