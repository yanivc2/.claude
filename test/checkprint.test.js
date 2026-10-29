import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment, getCheckPrintData } from '../src/services/payments.js';
import { shekelsToWords, amountToHebrewWords } from '../src/lib/hebrewAmount.js';
import { toAgorot } from '../src/lib/money.js';

test('shekelsToWords covers units, teens, tens, hundreds, thousands', () => {
  assert.equal(shekelsToWords(0), 'אפס');
  assert.equal(shekelsToWords(17), 'שבעה עשר');
  assert.equal(shekelsToWords(25), 'עשרים וחמישה');
  assert.equal(shekelsToWords(170), 'מאה ושבעים');
  assert.equal(shekelsToWords(200), 'מאתיים');
  assert.equal(shekelsToWords(1170), 'אלף מאה ושבעים');
  assert.equal(shekelsToWords(1234), 'אלף מאתיים שלושים וארבעה');
  assert.equal(shekelsToWords(5000), 'חמשת אלפים');
  assert.equal(shekelsToWords(10000), 'עשרת אלפים');
  assert.equal(shekelsToWords(100000), 'מאה אלף');
});

test('amountToHebrewWords appends the shekels/agorot suffix', () => {
  assert.equal(amountToHebrewWords(117000), 'אלף מאה ושבעים שקלים חדשים בלבד');
  assert.equal(amountToHebrewWords(117050), 'אלף מאה ושבעים שקלים חדשים ו-50/100 בלבד');
  assert.equal(amountToHebrewWords(9905), 'תשעים ותשעה שקלים חדשים ו-05/100 בלבד');
});

test('getCheckPrintData: payee = supplier name, supplier no. = its tax id, one row per document, digits + words', async () => {
  const db = await freshDb();
  // Use the store under "על הדרך סופר" (it carries a ח.פ, so the printed drawer shows a tax id).
  const st = await db.one("SELECT id FROM stores WHERE name = 'סופר על הדרך'", []);
  const sec = await secretary(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: 'מאפיית הבוקר' }, sec, db)).id, await owner(db), db);
  await db.run('UPDATE suppliers SET tax_id = ? WHERE id = ?', ['514737832', sup.id]);
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'X1', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('1000'), vatAmount: toAgorot('170'), docType: 'tax_invoice' },
    sec,
    db,
  );
  await approveInvoiceForPayment(invoice.id, sec, db);
  const payment = await createPayment(
    { bankAccountId: acct, checkNumber: '8801', paymentDate: '2026-07-02', invoiceIds: [invoice.id] },
    sec,
    db,
  );

  const data = await getCheckPrintData(payment.id, db);
  assert.equal(data.payee, 'מאפיית הבוקר', 'בעלים 29/10: שם הספק כמו באפליקציה');
  assert.equal(data.payeeTaxId, '514737832', 'בעלים 29/10: "מס׳ ספק" = ח.פ./ע.מ.');
  assert.equal(data.amountWords, 'אלף מאה ושבעים שקלים חדשים בלבד');
  assert.equal(data.amountDigits, '1,170.00');
  assert.equal(data.checkDate, '02/07/2026');
  assert.deepEqual(data.lines, [{ text: 'חשבונית X1 · 01/07/26', amount: 117000 }]);
  assert.equal(data.total, 117000);
  assert.equal(data.printCount, 0);
});

test('amountToHebrewWords: one and two shekels read as Hebrew, not "אחד שקלים"', () => {
  assert.equal(amountToHebrewWords(100), 'שקל חדש אחד בלבד');
  assert.equal(amountToHebrewWords(250), 'שני שקלים חדשים ו-50/100 בלבד');
});
