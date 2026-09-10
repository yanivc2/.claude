import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { cashExpensesByStore } from '../src/services/zclosing.js';
import { israelStamp } from '../src/lib/loginHours.js';

// created_at נשמר ב-UTC בשני הניבים. שעה שמוצגת כמות שהיא מזיזה כל פעולה 2-3 שעות אחורה —
// ובדיוק בשדה שנועד לענות על "מתי זה הוזן".
test('שעת שמירה מוצגת בשעון ישראל, כולל מעבר שעון קיץ/חורף', () => {
  assert.equal(israelStamp('2026-09-10 15:28:00'), '10/09/26 18:28'); // קיץ, UTC+3
  assert.equal(israelStamp('2026-01-10 15:28:00'), '10/01/26 17:28'); // חורף, UTC+2
  assert.equal(israelStamp('2026-09-10 22:30:00'), '11/09/26 01:30'); // חוצה חצות
  assert.equal(israelStamp(''), '');
  assert.equal(israelStamp(null), '');
  assert.equal(israelStamp('לא תאריך'), '');
});

async function seedCash(x, storeId, user) {
  const zr = await x.run(
    `INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, created_by)
     VALUES (?, '900', '2026-09-01', 100000, 50000, ?)`, [storeId, user.id]);
  await x.run(
    `INSERT INTO z_expenses (z_report_id, expense_date, payer_name, purpose, description_type, amount, created_at)
     VALUES (?, '2026-09-01', 'דנה', 'ניקיון', 'manual', 12000, '2026-09-01 06:05:00')`,
    [zr.lastInsertRowid]);
  const zc = await x.run(
    `INSERT INTO z_closings (employee_first, employee_last, store_id, z_number, drawer_cash, created_by)
     VALUES ('רון', 'לוי', ?, '901', 50000, ?)`, [storeId, user.id]);
  await x.run(
    `INSERT INTO z_closing_expenses (closing_id, expense_date, payer_name, purpose, description_type, amount, created_at)
     VALUES (?, '2026-09-02', 'רון', 'דלק', 'manual', 8000, '2026-09-02 07:15:00')`,
    [zc.lastInsertRowid]);
  return { zReportId: zr.lastInsertRowid, closingId: zc.lastInsertRowid };
}

test('הרובריקה מציגה את שני מקורות ההזנה, מקובצת לפי חנות', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const store = await firstStore(x);
  await seedCash(x, store.id, user);

  const groups = await cashExpensesByStore(null, 200, x);
  const g = groups.find((r) => Number(r.store_id) === Number(store.id));
  assert.ok(g, 'יש קבוצה לחנות');
  assert.equal(g.rows.length, 2, 'שתי הוצאות — אחת מכל מקור');
  assert.deepEqual(g.rows.map((r) => r.source), ['closing', 'zreport'], 'החדשה למעלה');
  assert.equal(g.total, 20000);
  // 🔴 פירוק לפי מקור: סכום אחד מכפיל בשקט הוצאה שהוזנה גם בסגירה וגם בדוח.
  assert.equal(g.totalClosing, 8000);
  assert.equal(g.totalReport, 12000);
  // כל שורה נושאת את המקור שלה כדי שאפשר יהיה לפתוח אותו
  assert.ok(g.rows.find((r) => r.closing_id));
  assert.ok(g.rows.find((r) => r.z_report_id));
  assert.ok(g.rows.every((r) => r.created_at));
});

test('הרובריקה מכבדת את הפרדת החנויות', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const stores = await x.many('SELECT * FROM stores ORDER BY id', []);
  await seedCash(x, stores[0].id, user);
  if (stores[1]) await seedCash(x, stores[1].id, user);

  const only = await cashExpensesByStore({ companyIds: null, storeIds: [stores[0].id] }, 200, x);
  assert.deepEqual(only.map((g) => Number(g.store_id)), [Number(stores[0].id)]);
});

test('שעת השמירה מופיעה בטבלת הוצאות המזומן, והרובריקה קיימת בדף המרקורים', () => {
  const partial = readFileSync(new URL('../src/views/partials/_cashExpenses.ejs', import.meta.url), 'utf8');
  assert.match(partial, /israelStamp\(e\.created_at\)/, 'שעת שמירה מומרת לשעון ישראל, לא מוצגת גולמית');
  assert.match(partial, /reports\/zreports\//, 'שורה של דוח Z מקושרת לדוח שלה');

  // 🔴 אותה תקלה בדיוק ברובריקת הייבואים: `imported_at` נשמר ב-UTC בשני הניבים, וחיתוך
  // המחרוזת הציג שעה מוקדמת ב-2-3 שעות מהשעה שבה הקובץ באמת הועלה.
  const recon = readFileSync(new URL('../src/views/reconciliation/index.ejs', import.meta.url), 'utf8');
  assert.match(recon, /israelStamp\(im\.imported_at\)/);

  const view = readFileSync(new URL('../src/views/payments/index.ejs', import.meta.url), 'utf8');
  assert.match(view, /הוצאות מזומן מהקופה/);
  assert.match(view, /_cashExpenses/);
});
