import { getExecutor } from '../db/adapter.js';
import { NotFoundError } from '../lib/errors.js';
import { normalizeScope } from '../lib/scope.js';
import { plainNumber } from '../lib/numText.js';

// "בחינת תנועה" — לחיוב בבנק (בעיקר "שיק" שהמערכת אומרת עליו "אין צ׳ק פתוח תואם"): מה הבנק אמר,
// ומה יש במערכת עם אותו מספר. התשובה היא אחת מאלה, וכל אחת מוצגת במפורש:
//   • צ׳ק פתוח באותו חשבון ובאותו סכום → אפשר לאשר פירעון כאן;
//   • אותו מספר בסכום אחר / כבר נפרע / בוטל / הונפק מחשבון אחר (חשד לעירבוב חשבונות);
//   • צ׳ק שכר באותו מספר;
//   • לא נמצא במערכת — כנראה הונפק לפני תחילת העבודה, או שלא הוזן.
// החיפוש נעשה בכל ההרשאות של המשתמש (`req.grantedScope`) ולא רק בחנות הפעילה: צ׳ק שהונפק מחשבון
// של חנות אחרת הוא בדיוק הממצא שמעניין כאן.

const refKey = (v) => plainNumber(String(v ?? '').trim()).replace(/\D/g, '').replace(/^0+/, '');

export async function inspectBankTxn(txnId, grantedScope = null, x = getExecutor()) {
  const txn = await x.one(
    `SELECT bt.*, ba.display_name AS account_name, ba.store_id AS account_store_id, st.name AS store_name,
            bi.file_name, bi.imported_at, bi.source AS import_source
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       JOIN stores st ON st.id = ba.store_id
       LEFT JOIN bank_imports bi ON bi.id = bt.import_id
      WHERE bt.id = ?`,
    [Number(txnId)],
  );
  if (!txn) throw new NotFoundError('התנועה לא נמצאה');
  const ref = refKey(txn.raw_reference);
  const amount = Math.abs(Number(txn.amount));
  const { companyIds, storeIds } = normalizeScope(grantedScope);
  const cos = companyIds == null ? null : new Set(companyIds.map(Number));
  const sts = storeIds == null ? null : new Set(storeIds.map(Number));
  const inScope = (companyId, storeId) => (!cos || cos.has(Number(companyId))) && (!sts || sts.has(Number(storeId)));

  // תשלומים עם אותו מספר (צ׳ק / אסמכתה / מקבץ), בכל החשבונות שהמשתמש מורשה להם.
  let payments = [];
  if (ref) {
    const all = await x.many(
      `SELECT p.id, p.method, p.check_number, p.reference, p.batch_number, p.amount, p.status, p.payment_date,
              p.cleared_date, p.bank_account_id, p.supplier_id, ba.display_name AS account_name,
              ba.company_id, ba.store_id
         FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id
        WHERE p.check_number IS NOT NULL OR p.reference IS NOT NULL OR p.batch_number IS NOT NULL`,
      [],
    );
    payments = all.filter((p) => inScope(p.company_id, p.store_id)
      && [p.check_number, p.reference, p.batch_number].some((v) => refKey(v) === ref));
  }
  // מי קיבל — מהחשבוניות של התשלום, ולמקדמה מהספק שעל התשלום.
  for (const p of payments) {
    const sup = await x.one(
      `SELECT s.name FROM payment_lines pl JOIN invoices i ON i.id = pl.invoice_id JOIN suppliers s ON s.id = i.supplier_id
        WHERE pl.payment_id = ? LIMIT 1`, [p.id],
    ) || (p.supplier_id ? await x.one('SELECT name FROM suppliers WHERE id = ?', [p.supplier_id]) : null);
    p.supplier_name = sup ? sup.name : '';
    const other = await x.one('SELECT id, txn_date FROM bank_transactions WHERE matched_payment_id = ? LIMIT 1', [p.id]);
    p.matched_txn = other || null;
    p.same_account = Number(p.bank_account_id) === Number(txn.bank_account_id);
    p.same_amount = Number(p.amount) === amount;
    p.verdict =
      !p.same_account ? 'other_account'
        : p.status === 'voided' ? 'voided'
          : p.status === 'cleared' ? 'cleared'
            : !p.same_amount ? 'amount_differs'
              : 'matchable';
  }

  // צ׳ק שכר באותו מספר.
  let salary = [];
  if (ref) {
    try {
      const rows = await x.many(
        `SELECT sp.id, sp.reference, sp.amount, sp.method, sp.due_date, sp.cashed, sp.store_id, sp.bank_txn_id,
                st.company_id, st.name AS store_name, e.first_name, e.last_name
           FROM salary_payments sp JOIN stores st ON st.id = sp.store_id JOIN employees e ON e.id = sp.employee_id
          WHERE sp.reference IS NOT NULL`,
        [],
      );
      salary = rows.filter((s) => inScope(s.company_id, s.store_id) && refKey(s.reference) === ref);
    } catch { salary = []; } // מסד לפני עדכון (bank_txn_id) — פשוט אין תוצאות שכר
  }

  // צ׳קים פתוחים באותו חשבון ובאותו סכום (מספר אחר) — אולי נרשם מספר שגוי.
  const sameAmountOpen = (await x.many(
    `SELECT p.id, p.check_number, p.reference, p.payment_date, p.supplier_id FROM payments p
      WHERE p.bank_account_id = ? AND p.status = 'issued' AND p.amount = ?`,
    [txn.bank_account_id, amount],
  )).filter((p) => !payments.some((q) => q.id === p.id));

  return { txn, ref, amount, payments, salary, sameAmountOpen };
}
