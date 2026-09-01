// Credit-card brands on the Z report: the owner's reporting order, and לאומיק. round-trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { CC_BRANDS, createZReport, setCreditCards, getZReport } from '../src/services/zreports.js';

test("CC_BRANDS is in the owner's reporting order and includes לאומיק.", () => {
  assert.deepEqual(
    CC_BRANDS.map((b) => b.label),
    ['ישראכרט', 'כ.א.ל', 'דיינרס', 'אמ. אקס', 'לאומיק.', 'כרטיס תייר', 'כללי'],
  );
});

test('every brand (including the new לאומיק.) is saved and totalled', async () => {
  const db = await freshDb();
  const own = await owner(db);
  const st = await firstStore(db);
  const z = await createZReport(
    { storeId: st.id, zNumber: 'CC1', zDate: '2026-09-01', dailyTotal: 100000, drawerCredit: 100000 },
    own, db,
  );

  const amounts = { isracard: 1000, kal: 2000, diners: 300, amex: 400, leumi: 5000, tourist: 600, general: 700 };
  await setCreditCards(z.id, { amounts }, own, db);

  const saved = await getZReport(z.id, db);
  assert.equal(saved.cc_leumi, 5000);
  assert.equal(saved.cc_isracard, 1000);
  assert.equal(saved.cc_total, 1000 + 2000 + 300 + 400 + 5000 + 600 + 700);
});
