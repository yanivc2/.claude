import { getExecutor } from '../db/adapter.js';

// App-wide key/value flags (entitlements/toggles) stored in app_settings. Reads are defensive:
// if the table is missing (an un-upgraded DB) they fall back to the default instead of throwing.

/** Raw string value for a key, or `fallback` when unset / on any read error. */
export async function getSetting(key, fallback = null, x = getExecutor()) {
  try {
    const row = await x.one('SELECT value FROM app_settings WHERE key = ?', [key]);
    return row && row.value != null ? row.value : fallback;
  } catch {
    return fallback;
  }
}

/** Upsert a key. Portable across SQLite/Postgres (delete-then-insert inside the same call). */
export async function setSetting(key, value, x = getExecutor()) {
  await x.run('DELETE FROM app_settings WHERE key = ?', [key]);
  // RETURNING key stops the PG adapter injecting "RETURNING id" (this table's PK is `key`, not id).
  await x.run('INSERT INTO app_settings (key, value) VALUES (?, ?) RETURNING key', [key, value == null ? null : String(value)]);
}

const SCAN_KEY = 'scan_enabled';

/** Is the invoice-scan feature unlocked? Default LOCKED (false) until the owner enables it. */
export async function isScanEnabled(x = getExecutor()) {
  return (await getSetting(SCAN_KEY, '0', x)) === '1';
}

/** Owner toggle for the scan feature. */
export async function setScanEnabled(on, x = getExecutor()) {
  await setSetting(SCAN_KEY, on ? '1' : '0', x);
}
