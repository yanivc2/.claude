import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZClosing } from '../src/services/zclosing.js';
import { unmatchedCashExpenses, setCashExpenseSettled } from '../src/services/zreports.js';
import { matchClosingExpenseToInvoice } from '../src/services/zclosing.js';

// 🔴 ההחלטה הקודמת כאן הייתה "תשלום מזומן = מטופל": הוצאת מזומן שיש לה תשלום־מזומן באותה חנות
// ובאותו סכום נחשבה מותאמת וירדה מהרשימה. הכלל בוטל בהחלטת הבעלים, כי הוא לא הסתכל על תאריך,
// על שם ולא על סיבה — נמדד: תשלום מינואר העלים הוצאה מספטמבר, כלומר הסתיר בשקט בדיוק את מה
// שהרשימה נועדה לתפוס. שורה יוצאת מהרשימה רק בדרך **מפורשת**: שיוך לחשבונית, קישור שכר/מפרעה,
// או סימון "טופל" ביד. הבדיקה הזו נועלת את הכלל החדש על אותו תרחיש בדיוק.
test('תשלום מזומן זהה בסכום אינו מוריד הוצאה — רק שיוך מפורש מוריד', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='טרה'", []);

  // an invoice paid via a CASH payment of ₪609
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: '94420', invoiceDate: '2026-08-25', amountBeforeVat: 60900, vatAmount: 0, docType: 'tax_invoice' }, ow, db);
  const inv = await db.one("SELECT id FROM invoices WHERE invoice_number='94420'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  await createPayment({ bankAccountId: ba.id, method: 'cash', payerName: 'הסניף', paymentDate: '2026-08-25', invoiceIds: [inv.id] }, ow, db);

  // a register close with TWO ₪609 cash expenses: one matches the payment, one does not
  await createZClosing({ employeeFirst: 'א', employeeLast: 'ב', zNumber: '2166', drawerCash: 200000, storeId: store.id, counts: {}, registers: [], expenses: [
    { kind: 'manual', expenseDate: '2026-08-25', payerName: 'טרה', purpose: 'טרה', amount: 60900 },
    { kind: 'manual', expenseDate: '2026-08-25', payerName: 'אחר', purpose: 'אחר', amount: 60900 },
  ] }, ow, db);

  // שתיהן נשארות: לתשלום המזומן אין שום קשר מוכח לאף אחת מהן.
  const unmatched = await unmatchedCashExpenses(null, 30, store.id, db);
  const mine = unmatched.filter((e) => Number(e.amount) === 60900);
  assert.equal(mine.length, 2);

  // שיוך מפורש לחשבונית — זו הדרך שהבעלים משתמש בה ("כל סכום יקבל חשבונית") — מוריד אחת.
  const byTera = mine.find((e) => e.payer_name === 'טרה');
  await matchClosingExpenseToInvoice(byTera.id, inv.id, ow, null, db);
  const afterMatch = await unmatchedCashExpenses(null, 30, store.id, db);
  assert.equal(afterMatch.filter((e) => Number(e.amount) === 60900).length, 1);

  // והשנייה — פריטה וכדומה — יורדת בסימון ידני, שהוא הפיך.
  const other = afterMatch.find((e) => Number(e.amount) === 60900);
  await setCashExpenseSettled(other.source, other.id, true, ow, null, db);
  const afterSettle = await unmatchedCashExpenses(null, 30, store.id, db);
  assert.equal(afterSettle.filter((e) => Number(e.amount) === 60900).length, 0);
});
