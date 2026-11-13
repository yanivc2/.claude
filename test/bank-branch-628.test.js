// 🏦 בעלים 13/11: "תתקן את הסניף ל-628". seed.js זרע את חשבונות הפועלים בסניף 428, ובבנק הסניף הוא 628.
// התקנה חדשה — 628 מההתחלה; מסד קיים — תיקון חד-פעמי ב"עדכן מסד נתונים" (db/dataFixes.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { applyDataFixes } from '../src/db/dataFixes.js';
import { resolveScrapedAccount } from '../src/lib/scraperMap.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let db;
before(async () => { db = await freshDb(); });

test('a fresh install seeds the Hapoalim accounts in branch 628, display name included', async () => {
  const rows = await db.many("SELECT branch, display_name FROM bank_accounts WHERE bank_name = 'הפועלים'", []);
  assert.ok(rows.length >= 4);
  for (const r of rows) {
    assert.equal(r.branch, '628');
    assert.match(r.display_name, / · הפועלים 628-\d+$/);
  }
  assert.deepEqual(await applyDataFixes(db), [], 'nothing to fix on a fresh install');
});

test('an existing DB seeded with 428: the button fixes branch and display name, once; nothing else is touched', async () => {
  const accts = await db.many('SELECT id, account_number FROM bank_accounts ORDER BY id', []);
  // the legacy state: 428 in the column and in the name — one with a renamed display, one whose account holds "428"
  await db.run("UPDATE bank_accounts SET branch = '428', display_name = 'א · הפועלים 428-' || account_number WHERE id = ?", [accts[0].id]);
  await db.run("UPDATE bank_accounts SET branch = '428', display_name = 'סופר בלי מספר' WHERE id = ?", [accts[1].id]);
  await db.run("UPDATE bank_accounts SET branch = '428', display_name = 'ג · הפועלים 428-4280' WHERE id = ?", [accts[2].id]);
  await db.run("UPDATE bank_accounts SET bank_name = 'לאומי', branch = '428', display_name = 'ד · לאומי 428-1' WHERE id = ?", [accts[3].id]);

  const notes = await applyDataFixes(db);
  assert.deepEqual(notes, ['סניף הבנק תוקן ל-628 ב-3 חשבונות.']);
  const after = Object.fromEntries((await db.many('SELECT id, bank_name, branch, display_name FROM bank_accounts', [])).map((r) => [r.id, r]));
  assert.equal(after[accts[0].id].branch, '628');
  assert.equal(after[accts[0].id].display_name, `א · הפועלים 628-${accts[0].account_number}`);
  assert.equal(after[accts[1].id].display_name, 'סופר בלי מספר', 'a renamed display stays as the owner wrote it');
  assert.equal(after[accts[1].id].branch, '628');
  assert.equal(after[accts[2].id].display_name, 'ג · הפועלים 628-4280', 'only " 428-", never digits inside an account number');
  assert.equal(after[accts[3].id].branch, '428', 'another bank is not ours to change');

  assert.deepEqual(await applyDataFixes(db), [], 'a second press changes nothing');
});

test('the scraped "12-628-<account>" now matches on branch + account, not only the account-number fallback', () => {
  const resolve = resolveScrapedAccount([{ id: 1, branch: '628', account_number: '432110' }, { id: 2, branch: '999', account_number: '432110' }]);
  assert.equal(resolve('12-628-432110')?.id, 1, 'with the same number in another branch, only the branch decides');
});

test('"עדכן מסד נתונים" says what it fixed', async () => {
  const o = await owner(db);
  const a = await db.one("SELECT id FROM bank_accounts WHERE bank_name = 'הפועלים' ORDER BY id LIMIT 1", []);
  await db.run("UPDATE bank_accounts SET branch = '428' WHERE id = ?", [a.id]);
  const server = createApp().listen(0); await once(server, 'listening');
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/settings/db-upgrade`, {
      method: 'POST', redirect: 'manual', headers: { cookie: `session=${createSession(o.id)}` },
    });
    assert.equal(r.status, 303);
    assert.match(decodeURIComponent(r.headers.get('location')), /סניף הבנק תוקן ל-628 ב-1 חשבון\./);
    assert.equal((await db.one('SELECT branch FROM bank_accounts WHERE id = ?', [a.id])).branch, '628');
  } finally { server.close(); }
});
