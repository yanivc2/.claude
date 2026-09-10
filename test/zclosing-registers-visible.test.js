// "פותח סגירה שמורה ורואה שאיזון הקופות לא נשמר."
//
// הוא כן נשמר — ונטען. מה שלא היה: הרובריקה בדף העריכה הייתה `<details>` **מקופלת תמיד**, בלי שום
// סימן שיש בתוכה משהו. פותחים סגירה, רואים רצועה סגורה, ומסיקים שהנתונים אבדו.
// רובריקה שמסתירה תוכן בלי לומר שהוא קיים היא שקר בתצוגה, ולכן שני הכללים כאן.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, owner, firstStore } from './helpers.js';
import { createZClosing, getZClosing } from '../src/services/zclosing.js';

const view = fs.readFileSync(path.join(process.cwd(), 'src/views/zclosing/edit.ejs'), 'utf8');

test('the rubric opens when the closing actually has registers', () => {
  assert.match(view, /<details class="card collapse-card"[^>]*<%= savedRegs\.length \? 'open' : '' %>>/,
    'closed-by-default over saved content is what made it look unsaved');
});

test('and the summary says what is inside, so it reads even while collapsed', () => {
  assert.match(view, /savedRegs\.length %> <%= savedRegs\.length === 1 \? 'קופה' : 'קופות' %> · <%= formatIls\(regTotal\)/);
});

test('the registers really do round-trip through the service', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  await createZClosing({
    employeeFirst: 'אלעד', employeeLast: 'אברזל', zNumber: '5001', drawerCash: 200000, storeId: store.id,
    counts: { 200: 3 }, expenses: [],
    registers: [
      { register: '1', storeId: store.id, counts: { 200: 15, 50: 4 } },
      { register: '2', storeId: store.id, counts: { 100: 7 } },
    ],
  }, ow, db);
  const saved = await db.one('SELECT id, registers FROM z_closings ORDER BY id DESC LIMIT 1', []);
  const regs = JSON.parse(saved.registers);
  assert.equal(regs.length, 2);
  assert.deepEqual(regs[0].breakdown, { 50: 4, 200: 15 });
  assert.equal(regs[0].total, 15 * 20000 + 4 * 5000, 'the total is computed server-side, never trusted from the form');
  assert.equal(regs[1].breakdown['100'], 7);
  // the counter is stamped from the closing's employee — the form no longer asks per register
  assert.equal(regs[0].first, 'אלעד');
  assert.ok(await getZClosing(saved.id, db));
});
