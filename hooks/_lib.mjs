// Shared helpers for the hook scripts in this directory.
//
// Every hook here follows the same contract as the PowerShell one-liners it
// replaced: exit 0 to let the tool call proceed, and never let a failure in a
// hook block a session. Only the guards exit non-zero, and only deliberately.

import { readFileSync } from 'node:fs';

/**
 * Read the hook payload Claude Code writes to stdin.
 * Returns {} when there is nothing to read, so a hook invoked by hand (or on an
 * event that sends no payload) still runs instead of hanging on fd 0.
 */
export function readPayload() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** Surface a message in the session without affecting the tool call. */
export function notify(systemMessage) {
  process.stdout.write(JSON.stringify({ systemMessage }));
}

/** Refuse the tool call and tell Claude why. Exits the process. */
export function block(stopReason) {
  process.stdout.write(JSON.stringify({ continue: false, stopReason }));
  process.exit(1);
}

/**
 * Matches a OneDrive path on either platform:
 *   Windows  C:\Users\yaniv\OneDrive\...
 *   macOS    ~/Library/CloudStorage/OneDrive-Company/...
 * The macOS form carries a suffix, but it is still preceded by a separator, so
 * one expression covers both.
 */
export const ONEDRIVE = /[\\/]OneDrive/i;

/** yyyyMMdd_HHmmss, matching the names the PowerShell backup hook produced. */
export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
