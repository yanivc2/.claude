// R8 — allocation between payments and invoices.
//
// Until now the model was 1:1 in one direction: a payment consumed each of its invoices WHOLE, and
// an invoice belonged to exactly one payment. That covers "several invoices + credit notes on one
// check" (which already worked) but not the mirror case: an invoice that arrives AFTER the money
// was paid, covering several payments already made — 12 rent checks handed over up front, then one
// invoice for 3 months of rent.
//
// The table was already many-to-many (payment_lines: payment_id, invoice_id, amount_applied); what
// was missing were the rules. Two derived quantities carry the whole feature:
//
//   payment.unallocated = payment.amount − Σ its lines     ("יתרה על החשבון" — an open advance)
//   invoice.open        = invoice.total_amount − Σ its lines ("יתרה לתשלום")
//
// An ADVANCE is simply a payment whose lines don't yet cover its amount. Nothing about a fully
// allocated payment changes, so every existing payment reads as it always did (unallocated = 0).
//
// Invoice status stays the existing enum — no new value, no CHECK rebuild. An invoice flips to
// 'paid' exactly when it is fully allocated and drops back to 'approved_for_payment' when an
// allocation is removed, so "partly covered" is simply "still payable, with a smaller balance".

import { getExecutor, tx } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

/** Voided payments hold no money: their lines never count toward an invoice's allocation. */
const LIVE = "p.status <> 'voided'";

/**
 * How much of a payment is already matched to invoices, and how much is still on account.
 * @returns {{amount:number, allocated:number, unallocated:number}} agorot
 */
export async function paymentAllocation(paymentId, x = getExecutor()) {
  const p = await x.one('SELECT amount, status FROM payments WHERE id = ?', [paymentId]);
  if (!p) throw new NotFoundError(`תשלום ${paymentId} לא נמצא`);
  const row = await x.one(
    'SELECT COALESCE(SUM(amount_applied),0) AS s FROM payment_lines WHERE payment_id = ?',
    [paymentId],
  );
  const amount = p.status === 'voided' ? 0 : Number(p.amount);
  const allocated = Number(row.s);
  return { amount, allocated, unallocated: amount - allocated };
}

/**
 * How much of an invoice is covered by live payments, and how much is still open.
 * @returns {{total:number, allocated:number, open:number}} agorot
 */
export async function invoiceAllocation(invoiceId, x = getExecutor()) {
  const inv = await x.one('SELECT total_amount FROM invoices WHERE id = ?', [invoiceId]);
  if (!inv) throw new NotFoundError(`חשבונית ${invoiceId} לא נמצאה`);
  const row = await x.one(
    `SELECT COALESCE(SUM(pl.amount_applied),0) AS s
       FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
      WHERE pl.invoice_id = ? AND ${LIVE}`,
    [invoiceId],
  );
  const total = Number(inv.total_amount);
  const allocated = Number(row.s);
  return { total, allocated, open: total - allocated };
}

/**
 * Payments of one supplier that still carry money on account — the candidates an arriving invoice
 * can be attached to. Restricted to the invoice's own bank account, because a payment and the
 * invoice it settles must be on the same account (the same rule createPayment enforces).
 *
 * A payment qualifies if it is live and its lines don't already cover its amount. Its supplier is
 * the one recorded on the payment (an advance) or the one its existing lines point at.
 */
export async function openAdvancesForSupplier(supplierId, bankAccountId, x = getExecutor()) {
  // Deliberately several small queries instead of one clever statement: pg-mem (the Postgres
  // dialect the tests run against) implements neither correlated EXISTS subqueries nor Postgres'
  // "GROUP BY the primary key, SELECT every column" rule. Same reason enrichPaidStatus sums in JS.

  // A payment belongs to this supplier either explicitly (an advance) or through its lines.
  const viaLines = await x.many(
    `SELECT DISTINCT pl.payment_id FROM payment_lines pl
       JOIN invoices i ON i.id = pl.invoice_id
      WHERE i.supplier_id = ?`,
    [supplierId],
  );
  const lineIds = viaLines.map((r) => Number(r.payment_id));

  const direct = await x.many(
    "SELECT * FROM payments WHERE status <> 'voided' AND bank_account_id = ? AND supplier_id = ?",
    [bankAccountId, supplierId],
  );
  const indirect = lineIds.length
    ? await x.many(
        `SELECT * FROM payments
          WHERE status <> 'voided' AND bank_account_id = ?
            AND id IN (${lineIds.map(() => '?').join(',')})`,
        [bankAccountId, ...lineIds],
      )
    : [];

  const byId = new Map();
  for (const r of [...direct, ...indirect]) byId.set(Number(r.id), r);
  const rows = [...byId.values()].sort(
    (a, b) => String(a.payment_date).localeCompare(String(b.payment_date)) || Number(a.id) - Number(b.id),
  );
  if (!rows.length) return [];

  const lines = await x.many(
    `SELECT pl.payment_id, pl.amount_applied FROM payment_lines pl
      WHERE pl.payment_id IN (${rows.map(() => '?').join(',')})`,
    rows.map((r) => r.id),
  );
  const allocatedBy = new Map();
  for (const l of lines) {
    allocatedBy.set(Number(l.payment_id), (allocatedBy.get(Number(l.payment_id)) || 0) + Number(l.amount_applied));
  }

  return rows
    .map((r) => {
      const allocated = allocatedBy.get(Number(r.id)) || 0;
      return { ...r, allocated, unallocated: Number(r.amount) - allocated };
    })
    .filter((r) => r.unallocated > 0);
}

/**
 * Recompute one invoice's status from its live allocations. The single place that decides "paid":
 * called after every allocation change, after a void, and after a payment edit, so the status can
 * never drift from the lines.
 *
 * Fully allocated → 'paid'. Otherwise back to a payable state — 'approved_for_payment', unless the
 * invoice is on_hold (R3), which is a block that allocation must not silently clear.
 */
export async function syncInvoicePaidStatus(invoiceId, bankAccountId, x = getExecutor()) {
  const inv = await x.one('SELECT id, status, total_amount FROM invoices WHERE id = ?', [invoiceId]);
  if (!inv) throw new NotFoundError(`חשבונית ${invoiceId} לא נמצאה`);
  if (inv.status === 'on_hold') return inv.status; // R3 hold outranks allocation

  const { allocated, total } = await invoiceAllocation(invoiceId, x);
  const covered = total > 0 ? allocated >= total : allocated !== 0;

  if (covered) {
    await x.run(
      'UPDATE invoices SET status = ?, bank_account_id = COALESCE(?, bank_account_id) WHERE id = ?',
      ['paid', bankAccountId ?? null, invoiceId],
    );
    return 'paid';
  }
  // Not covered: payable again. Keep 'recorded' as-is (never approved), otherwise approved.
  const next = inv.status === 'recorded' ? 'recorded' : 'approved_for_payment';
  await x.run('UPDATE invoices SET status = ?, bank_account_id = ? WHERE id = ?', [
    next,
    allocated > 0 ? (bankAccountId ?? null) : null,
    invoiceId,
  ]);
  return next;
}

/**
 * Attach an invoice to money that was ALREADY paid: allocate it against one or more existing
 * payments' open balances. This is the mirror of paying several invoices with one check.
 *
 * @param {number} invoiceId
 * @param {Array<{paymentId:number, amount?:number}>} allocations
 *        `amount` in agorot; omitted = take as much as that payment and the invoice still allow,
 *        which is what the 3-rent-checks case wants (whole checks, in order).
 * @returns {{invoiceId:number, applied:number, open:number, status:string, lines:Array}}
 */
export async function allocateInvoiceToPayments(invoiceId, allocations, actor, x = getExecutor()) {
  const wanted = (allocations || []).filter((a) => a && a.paymentId);
  if (!wanted.length) throw new RuleError('R8', 'לא נבחרו תשלומים לשיוך');

  return tx(async (t) => {
    const inv = await t.one(
      `SELECT i.*, s.status AS supplier_status, s.name AS supplier_name
         FROM invoices i JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.id = ?`,
      [invoiceId],
    );
    if (!inv) throw new NotFoundError(`חשבונית ${invoiceId} לא נמצאה`);
    if (inv.status === 'on_hold') {
      throw new RuleError('R3', 'החשבונית מוחזקת (R3) — שחרר אותה לפני שיוך לתשלומים', { invoiceId });
    }
    if (inv.supplier_status !== 'approved') {
      throw new RuleError('R1', `הספק "${inv.supplier_name}" אינו מאושר — שיוך חסום`, { invoiceId });
    }
    if (Number(inv.total_amount) <= 0) {
      throw new RuleError('R8', 'לא ניתן לשייך חשבונית זיכוי לתשלום קיים — צרף אותה לתשלום חדש יחד עם חשבונית המס');
    }

    let open = (await invoiceAllocation(invoiceId, t)).open;
    if (open <= 0) throw new RuleError('R8', 'החשבונית כבר משויכת במלואה לתשלומים');

    const lines = [];
    let bankAccountId = null;

    for (const a of wanted) {
      if (open <= 0) break;
      const pay = await t.one('SELECT * FROM payments WHERE id = ?', [a.paymentId]);
      if (!pay) throw new NotFoundError(`תשלום ${a.paymentId} לא נמצא`);
      if (pay.status === 'voided') throw new RuleError('R8', `תשלום #${pay.id} מבוטל — לא ניתן לשייך אליו`);

      // Same-account rule, identical to createPayment: an invoice is settled from the account its
      // store banks with, and every payment on it must be that same account.
      const storeAcct = await t.one('SELECT id FROM bank_accounts WHERE store_id = ?', [inv.store_id]);
      if (storeAcct && pay.bank_account_id !== storeAcct.id) {
        throw new RuleError('ACCOUNT', `תשלום #${pay.id} מחשבון בנק אחר — שיוך אפשרי רק מחשבון החנות של החשבונית`);
      }
      bankAccountId = pay.bank_account_id;

      const already = await t.one(
        'SELECT id FROM payment_lines WHERE payment_id = ? AND invoice_id = ?',
        [pay.id, invoiceId],
      );
      if (already) throw new RuleError('R8', `חשבונית זו כבר משויכת לתשלום #${pay.id}`);

      const { unallocated } = await paymentAllocation(pay.id, t);
      if (unallocated <= 0) {
        throw new RuleError('R8', `לתשלום #${pay.id} אין יתרה פנויה לשיוך — כולו כבר משויך לחשבוניות`);
      }

      // Take what was asked, capped by both sides — never over-allocate a payment or an invoice.
      const asked = Number.isFinite(a.amount) && a.amount > 0 ? Math.floor(a.amount) : Math.min(unallocated, open);
      const applied = Math.min(asked, unallocated, open);
      if (applied <= 0) continue;

      await t.run('INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, ?)', [
        pay.id, invoiceId, applied,
      ]);
      lines.push({ paymentId: pay.id, applied });
      open -= applied;
    }

    if (!lines.length) throw new RuleError('R8', 'לא נותרה יתרה לשיוך בתשלומים שנבחרו');

    const status = await syncInvoicePaidStatus(invoiceId, bankAccountId, t);
    const applied = lines.reduce((n, l) => n + l.applied, 0);

    await logAction(
      {
        userId: actor?.id ?? null,
        action: 'invoice.allocate',
        entityType: 'invoice',
        entityId: invoiceId,
        details: { applied, open, status, payments: lines.map((l) => l.paymentId) },
      },
      t,
    );
    return { invoiceId, applied, open, status, lines };
  });
}

/**
 * Undo one allocation: detach an invoice from a payment. The money goes back to being on account
 * and the invoice becomes payable again for that amount.
 */
export async function deallocate(invoiceId, paymentId, actor, x = getExecutor()) {
  return tx(async (t) => {
    const line = await t.one('SELECT * FROM payment_lines WHERE payment_id = ? AND invoice_id = ?', [
      paymentId, invoiceId,
    ]);
    if (!line) throw new NotFoundError('השיוך לא נמצא');
    const pay = await t.one('SELECT status, bank_account_id FROM payments WHERE id = ?', [paymentId]);
    if (pay?.status === 'cleared') {
      throw new RuleError('R8', 'התשלום כבר נפרע — בטל את הפירעון לפני שינוי השיוך');
    }

    await t.run('DELETE FROM payment_lines WHERE payment_id = ? AND invoice_id = ?', [paymentId, invoiceId]);
    const status = await syncInvoicePaidStatus(invoiceId, pay?.bank_account_id ?? null, t);

    await logAction(
      {
        userId: actor?.id ?? null,
        action: 'invoice.deallocate',
        entityType: 'invoice',
        entityId: invoiceId,
        details: { paymentId, amount: Number(line.amount_applied), status },
      },
      t,
    );
    return { invoiceId, paymentId, status };
  });
}
