// שיוך חיוב בנק לחשבונית אחת או לכמה — חיוב שיצא מהבנק בלי שנרשם כאן צ׳ק (העברה / הוראת קבע /
// חיוב ישיר שהספק גבה). עד עכשיו השורה אמרה "אין צ׳ק פתוח תואם" ולא הייתה שום דרך לסגור אותה,
// והחשבונית נשארה "לתשלום" אחרי שכבר שולמה — כלומר מועמדת לתשלום שני.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { matchTxnToInvoices } from '../src/services/reconciliation.js';
import { unmatch } from '../src/services/reconciliation.js';
import { invoiceAllocation } from '../src/services/allocations.js';

async function setup(db) {
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('אסם', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='אסם'", []);
  return { ow, store, ba, sup };
}

async function invoice(db, ow, sup, store, number, agorot) {
  await createInvoice({
    supplierId: sup.id, storeId: store.id, invoiceNumber: number, invoiceDate: '2026-09-01',
    amountBeforeVat: agorot, vatAmount: 0, docType: 'tax_invoice',
  }, ow, db);
  const inv = await db.one('SELECT id FROM invoices WHERE invoice_number = ?', [number]);
  await approveInvoiceForPayment(inv.id, ow, db);
  return inv.id;
}

async function debit(db, ba, agorot, date = '2026-09-03') {
  const r = await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference)
     VALUES (?, ?, ?, 'העברה לאסם', '55501')`,
    [ba.id, date, -agorot],
  );
  return r.lastInsertRowid;
}

test('חיוב אחד סוגר כמה חשבוניות, והן מסומנות כשולמו', async () => {
  const db = await freshDb();
  const { ow, store, ba, sup } = await setup(db);
  const a = await invoice(db, ow, sup, store, '7001', 30000);
  const b = await invoice(db, ow, sup, store, '7002', 20000);
  const txn = await debit(db, ba, 50000);

  const r = await matchTxnToInvoices(txn, [a, b], {}, ow, db);
  assert.equal(r.stillOpen, 0, 'שתי החשבוניות נסגרו במלואן');

  // 🔴 הקישור עובר דרך תשלום אמיתי — אחרת syncInvoicePaidStatus לא היה מסמן כלום, והחשבונית
  // הייתה נשארת פתוחה עם מראה של טיפול.
  for (const id of [a, b]) {
    const inv = await db.one('SELECT status FROM invoices WHERE id = ?', [id]);
    assert.equal(inv.status, 'paid', `חשבונית ${id} סומנה כשולמה`);
    assert.equal((await invoiceAllocation(id, db)).open, 0);
  }
  const t = await db.one('SELECT matched_payment_id FROM bank_transactions WHERE id = ?', [txn]);
  assert.equal(Number(t.matched_payment_id), Number(r.paymentId), 'התנועה מקושרת לתשלום שנוצר');
  const p = await db.one('SELECT status, amount, method FROM payments WHERE id = ?', [r.paymentId]);
  assert.equal(p.status, 'cleared');
  assert.equal(Number(p.amount), 50000, 'התשלום נרשם בסכום שיצא מהבנק');
  assert.equal(p.method, 'transfer');
});

test('חיוב קטן מסכום החשבוניות = תשלום חלקי, והיתרה נשארת פתוחה', async () => {
  const db = await freshDb();
  const { ow, store, ba, sup } = await setup(db);
  const a = await invoice(db, ow, sup, store, '7010', 100000);
  const txn = await debit(db, ba, 40000);

  const r = await matchTxnToInvoices(txn, [a], {}, ow, db);
  assert.equal(r.allocated, 40000);
  assert.equal(r.stillOpen, 60000, 'נותרה יתרה פתוחה — לא סגירה מלאה');
  const inv = await db.one('SELECT status FROM invoices WHERE id = ?', [a]);
  assert.notEqual(inv.status, 'paid', 'חשבונית ששולמה חלקית אינה "שולמה"');
});

// סכום מעל היתרה הוא טעות הקלדה/בחירה, לא הוראה: התנועה גדולה מכל מה שפתוח בחשבוניות שנבחרו.
test('חיוב גדול מהיתרה הפתוחה נדחה ואינו יוצר תשלום', async () => {
  const db = await freshDb();
  const { ow, store, ba, sup } = await setup(db);
  const a = await invoice(db, ow, sup, store, '7020', 10000);
  const txn = await debit(db, ba, 90000);

  await assert.rejects(() => matchTxnToInvoices(txn, [a], {}, ow, db), /מעבר ליתרה/);
  const t = await db.one('SELECT matched_payment_id FROM bank_transactions WHERE id = ?', [txn]);
  assert.ok(!t.matched_payment_id, 'התנועה נשארה לא מותאמת');
  const n = await db.one('SELECT COUNT(*) AS n FROM payments', []);
  assert.equal(Number(n.n), 0, 'לא נוצר תשלום יתום');
});

// חיוב אחד בבנק הוא תשלום לספק אחד. שני ספקים = לא ניתן לדעת למי שולם.
test('חשבוניות של שני ספקים נדחות', async () => {
  const db = await freshDb();
  const { ow, store, ba, sup } = await setup(db);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('תנובה', 'approved')", []);
  const sup2 = await db.one("SELECT * FROM suppliers WHERE name='תנובה'", []);
  const a = await invoice(db, ow, sup, store, '7030', 10000);
  const b = await invoice(db, ow, sup2, store, '7031', 10000);
  const txn = await debit(db, ba, 20000);
  await assert.rejects(() => matchTxnToInvoices(txn, [a, b], {}, ow, db), /כמה ספקים/);
});

// זיכוי בבנק אינו תשלום לספק; שיוכו לחשבונית היה רושם תשלום שלא קרה.
test('תנועת זכות אינה ניתנת לשיוך לחשבונית', async () => {
  const db = await freshDb();
  const { ow, store, ba, sup } = await setup(db);
  const a = await invoice(db, ow, sup, store, '7040', 10000);
  const r = await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description)
     VALUES (?, '2026-09-03', 10000, 'זיכוי')`, [ba.id],
  );
  await assert.rejects(() => matchTxnToInvoices(r.lastInsertRowid, [a], {}, ow, db), /תנועת חובה/);
});

// "בטל התאמה" הקיים חייב לעבוד גם על זה — בלי קוד נוסף, כי התנועה מקושרת לתשלום כמו כל התאמה.
test('ביטול התאמה משחרר את התנועה', async () => {
  const db = await freshDb();
  const { ow, store, ba, sup } = await setup(db);
  const a = await invoice(db, ow, sup, store, '7050', 25000);
  const txn = await debit(db, ba, 25000);
  const r = await matchTxnToInvoices(txn, [a], {}, ow, db);

  await unmatch(txn, ow, db);
  const t = await db.one('SELECT matched_payment_id FROM bank_transactions WHERE id = ?', [txn]);
  assert.ok(!t.matched_payment_id);
  const p = await db.one('SELECT status FROM payments WHERE id = ?', [r.paymentId]);
  assert.equal(p.status, 'issued', 'התשלום חוזר להיות פתוח');
});
