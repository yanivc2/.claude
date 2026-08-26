import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary } from './helpers.js';
import {
  authorizedStoreIds, authorizedCompanyIds, setUserStores, setUserCompanies,
  availableStoresFor, getUserStoreIds, storeGrantMatrix,
} from '../src/lib/scope.js';

// Seed: companies 1..4, each with exactly one store — store 1→company 2, 2→1, 3→3, 4→4.

test('owner sees all stores (null) and every store is available with its company name', async () => {
  const x = await freshDb();
  const ow = await owner(x);
  assert.equal(await authorizedStoreIds(ow, x), null); // null = all
  const avail = await availableStoresFor(ow, x);
  assert.equal(avail.length, 4);
  assert.ok(avail[0].company_name); // grouped/labelled by company
});

test('no store grants → all stores in the granted companies (backward compatible)', async () => {
  const x = await freshDb();
  const sec = await secretary(x);
  await setUserStores(sec.id, [], x);
  await setUserCompanies(sec.id, [2], x); // company 2 owns store id 1
  assert.deepEqual((await authorizedStoreIds(sec, x)).map(Number), [1]);
  const avail = await availableStoresFor(sec, x);
  assert.equal(avail.length, 1);
  assert.equal(Number(avail[0].id), 1);
});

test('explicit store grants pin the user to exactly those stores and imply their companies', async () => {
  const x = await freshDb();
  const sec = await secretary(x);
  await setUserCompanies(sec.id, [], x); // no company grants
  await setUserStores(sec.id, [3, 4], x);
  assert.deepEqual((await authorizedStoreIds(sec, x)).map(Number).sort(), [3, 4]);
  // store grants must imply their parent companies so existing company-scoped queries still pass
  assert.deepEqual((await authorizedCompanyIds(sec, x)).map(Number).sort(), [3, 4]);
});

test('setUserStores replaces (not appends); storeGrantMatrix reflects the current set', async () => {
  const x = await freshDb();
  const sec = await secretary(x);
  await setUserStores(sec.id, [3], x);
  await setUserStores(sec.id, [4], x); // replace, not append
  assert.deepEqual((await getUserStoreIds(sec.id, x)).map(Number), [4]);
  const m = await storeGrantMatrix(x);
  assert.deepEqual([...(m.get(sec.id) || [])].map(Number), [4]);
});
