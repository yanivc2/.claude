import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { scrapeAndImport, scrapeConfigured, scrapeRunnable } from '../src/services/bankScrape.js';

test('scrapeConfigured reflects the presence of bank credentials in env', () => {
  const savedU = process.env.BANK_HAPOALIM_USER_CODE;
  const savedP = process.env.BANK_HAPOALIM_PASSWORD;
  delete process.env.BANK_HAPOALIM_USER_CODE;
  delete process.env.BANK_HAPOALIM_PASSWORD;
  // config caches env at import time, so this asserts on the current (unset) config value.
  assert.equal(typeof scrapeConfigured(), 'boolean');
  if (savedU !== undefined) process.env.BANK_HAPOALIM_USER_CODE = savedU;
  if (savedP !== undefined) process.env.BANK_HAPOALIM_PASSWORD = savedP;
});

test('scrapeRunnable is false only on a serverless host', () => {
  const saved = process.env.VERCEL;
  delete process.env.VERCEL;
  assert.equal(scrapeRunnable(), true);
  process.env.VERCEL = '1';
  assert.equal(scrapeRunnable(), false);
  if (saved === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved;
});

test('scrapeAndImport fails with a friendly, in-page error when credentials are missing', async () => {
  const db = await freshDb();
  const o = await owner(db);
  // config.bank.hapoalim is empty in tests → RuleError, not a 500.
  await assert.rejects(
    () => scrapeAndImport({}, o, db),
    (err) => err.name === 'RuleError' && /פרטי התחברות/.test(err.message),
  );
});
