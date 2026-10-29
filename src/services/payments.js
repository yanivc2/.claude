import { israelNow } from './zclosing.js';
import { getExecutor, tx } from '../db/adapter.js';
import { authorityPaymentsReady } from './authorityPayments.js';
import { config } from '../config.js';
import { NotFoundError, RuleError, AuthError } from '../lib/errors.js';
import { userCan } from '../lib/permissions.js';
import { scopeClause, scopeWhere } from '../lib/scope.js';
import { parseSearchTerms, anyTermLike } from '../lib/search.js';
import { amountToHebrewWords } from '../lib/hebrewAmount.js';
import { fromAgorot } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { israelToday, israelDayOf } from '../lib/loginHours.js';
import { logAction } from './audit.js';
import { syncInvoicePaidStatus } from './allocations.js';
import { supplierFamilyIds } from './suppliers.js';

const METHODS = ['check', 'cash', 'credit', 'transfer', 'batch', 'standing_order'];

/** Parse supplier payment-terms text → number of days (מיידי = 0, "שוטף 30" = 30). null if unknown. */
export function parsePaymentTermsDays(terms) {
  const t = String(terms || '').trim();
  if (!t) return null;
  if (/מיידי/.test(t)) return 0;
  const m = t.match(/\d+/);
  return m ? Number(m[0]) : null;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00`);
  const b = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Which paid invoices were paid EARLIER than the supplier's payment terms (§7 — Telegram push).
 *
 * The terms clock starts at the TAX INVOICE only: a credit note (`docType === 'credit_note'`)
 * reduces the amount, it never sets the due date. When one payment nets several tax invoices of
 * the same supplier, the EARLIEST tax-invoice date is the basis (its terms window closes first),
 * so a supplier yields at most one alert. Rows without a `docType` count as tax invoices.
 * @param {Array<{supplierId?,supplierName,invoiceNumber,invoiceDate,terms,docType?}>} rows
 * @param {string} paymentDate ISO date
 * @returns {Array<{supplierName,invoiceNumber,termsDays,actualDays,earlyDays,invoiceDate}>}
 */
export function earlyPaymentAlerts(rows, paymentDate) {
  // Earliest tax invoice per supplier.
  const basis = new Map();
  for (const r of rows || []) {
    if (r.docType === 'credit_note') continue;
    const key = r.supplierId != null ? `#${r.supplierId}` : `n:${r.supplierName || ''}`;
    const prev = basis.get(key);
    if (!prev || String(r.invoiceDate).slice(0, 10) < String(prev.invoiceDate).slice(0, 10)) basis.set(key, r);
  }

  const out = [];
  for (const r of basis.values()) {
    const termsDays = parsePaymentTermsDays(r.terms);
    if (termsDays == null) continue;
    const actual = daysBetween(r.invoiceDate, paymentDate);
    if (actual == null) continue;
    if (actual < termsDays) {
      out.push({
        supplierName: r.supplierName,
        invoiceNumber: r.invoiceNumber,
        invoiceDate: r.invoiceDate,
        termsDays,
        actualDays: actual,
        earlyDays: termsDays - actual,
      });
    }
  }
  return out;
}

/**
 * Issue a payment (check/cash/credit/transfer/batch), in one of two shapes:
 *
 *  • AGAINST INVOICES — pass `invoiceIds`. The amount is the net of those invoices and credit
 *    notes (never typed by hand), each is consumed whole, and R5 holds: amount == Σ lines.
 *  • AS AN ADVANCE (R8) — pass `supplierId` + `amount` and no invoices. This is money paid before
 *    its invoice exists: 12 rent checks handed over up front. The payment carries its supplier so
 *    the invoice can find it later; the whole amount sits unallocated ("על החשבון") until an
 *    invoice is attached with allocateInvoiceToPayments.
 *
 * Enforces the method's identifier either way; R1 (invoice approved_for_payment AND supplier
 * approved) and the cash ceiling on both.
 * @returns {object} the created payment with its lines
 */
/** כמה זמן אחרי "בטל שיוך" אפשר להנפיק שוב את אותו מספר צ׳ק (בעלים 25/10: "לא יאוחר משעה אחרי הפירוק"). */
export const REISSUE_WINDOW_MINUTES = 60;

/**
 * האם מספר הצ׳ק של תשלום קיים (`paymentId`) פנוי להנפקה מחדש, ולמי. בעלים 25/10: "במידה ועשיתי ביטול התאמה
 * לצ׳ק [בטל שיוך בדף החשבונית], ואני רוצה להנפיק תשלום לחשבונית אחרת עם אותו מספר הצ׳ק — אפשר זאת כל עוד אני
 * משלם אך ורק לאותו הספק ולא יאוחר משעה אחרי הפירוק". כל התנאים:
 *   • הצ׳ק "הונפק" בלבד, לא הותאם לתנועת בנק, ו**אין עליו אף חשבונית** (פורק לגמרי);
 *   • "בטל שיוך" (`invoice.deallocate`) האחרון ממנו — לפני פחות מ-REISSUE_WINDOW_MINUTES דקות (שעון UTC של היומן);
 *   • התשלום החדש לאותו ספק בדיוק (לא חברת-אם/בת) שהיו עליו החשבוניות שפורקו.
 * @returns {Promise<{ok:boolean, why?:string}>} why — הסבר בעברית כשלא (רק כשהיה פירוק; אחרת ההודעה הרגילה).
 */
export async function reissuableCheck(paymentId, { invoiceIds = [], supplierId = null } = {}, x = getExecutor()) {
  const p = await x.one('SELECT id, status, supplier_id FROM payments WHERE id = ?', [paymentId]);
  if (!p || p.status !== 'issued') return { ok: false };
  const lines = await x.one('SELECT COUNT(*) AS n FROM payment_lines WHERE payment_id = ?', [paymentId]);
  if (Number(lines?.n || 0) > 0) return { ok: false };
  const matched = await x.one('SELECT 1 AS m FROM bank_transactions WHERE matched_payment_id = ? LIMIT 1', [paymentId]);
  if (matched) return { ok: false };
  const deallocs = (await x.many(
    "SELECT entity_id, timestamp, details FROM audit_log WHERE action = 'invoice.deallocate' AND details LIKE ? ORDER BY id DESC",
    [`%"paymentId":${Number(paymentId)}%`],
  )).filter((r) => { try { return Number(JSON.parse(r.details).paymentId) === Number(paymentId); } catch { return false; } });
  if (!deallocs.length) return { ok: false };
  const cutoff = new Date(Date.now() - REISSUE_WINDOW_MINUTES * 60000).toISOString().slice(0, 19).replace('T', ' ');
  if (String(deallocs[0].timestamp) < cutoff) {
    return { ok: false, why: `עברה יותר משעה מ"בטל שיוך" — הנפקה מחדש של אותו מספר צ׳ק מותרת רק בשעה שאחרי הפירוק. בטל את הצ׳ק הקודם כדי לשחרר את המספר.` };
  }
  const oldSup = new Set();
  if (p.supplier_id) oldSup.add(Number(p.supplier_id));
  for (const d of deallocs) {
    const inv = await x.one('SELECT supplier_id FROM invoices WHERE id = ?', [d.entity_id]);
    if (inv) oldSup.add(Number(inv.supplier_id));
  }
  const newSup = new Set(supplierId ? [Number(supplierId)] : []);
  for (const id of invoiceIds) {
    const inv = await x.one('SELECT supplier_id FROM invoices WHERE id = ?', [Number(id)]);
    if (inv) newSup.add(Number(inv.supplier_id));
  }
  const same = oldSup.size === 1 && newSup.size === 1 && [...oldSup][0] === [...newSup][0];
  if (!same) return { ok: false, why: 'מספר צ׳ק שפורק מותר להנפקה מחדש רק לאותו ספק שהצ׳ק היה שלו.' };
  return { ok: true };
}

export async function createPayment(input, actor, x = getExecutor()) {
  const {
    bankAccountId,
    method = 'check',
    checkNumber,
    reference,
    payerName,
    cardLast4,
    batchNumber,
    paymentDate,
    invoiceIds = [],
    supplierId = null,
    amount: advanceAmount = null,
  } = input;

  if (!METHODS.includes(method)) throw new RuleError('VALIDATION', `אמצעי תשלום לא תקין: ${method}`);
  if (!paymentDate) throw new RuleError('VALIDATION', 'תאריך תשלום חובה');

  // An advance replaces the invoices, never joins them: with invoices the amount is DERIVED, and
  // accepting a typed amount alongside them would be a way to break R5.
  const isAdvance = !Array.isArray(invoiceIds) || invoiceIds.length === 0;
  if (isAdvance) {
    if (!supplierId) {
      throw new RuleError('R8', 'תשלום על החשבון (ללא חשבונית) — חובה לבחור ספק, אחרת לא נדע למי שולם');
    }
    if (!Number.isFinite(Number(advanceAmount)) || Number(advanceAmount) <= 0) {
      throw new RuleError('R8', 'תשלום על החשבון — חובה סכום חיובי');
    }
  } else if (advanceAmount != null) {
    throw new RuleError('R5', 'כשמצורפות חשבוניות הסכום נגזר מהן — לא ניתן להזין סכום ידני');
  }

  // ---- per-method identifier (the "no payment without an identifier" control) --
  const fields = { check_number: null, reference: null, payer_name: null, card_last4: null, batch_number: null };
  if (method === 'check') {
    if (!checkNumber || !String(checkNumber).trim()) throw new RuleError('CHECK', 'לא ניתן להנפיק צ׳ק ללא מספר צ׳ק');
    fields.check_number = String(checkNumber).trim();
  } else if (method === 'cash') {
    if (!payerName || !String(payerName).trim()) throw new RuleError('VALIDATION', 'תשלום מזומן — שם המשלם חובה');
    fields.payer_name = String(payerName).trim();
  } else if (method === 'credit') {
    // 4 ספרות אחרונות אינן חובה; אם הוזנו — הן חייבות להיות בדיוק 4 ספרות.
    const last4 = String(cardLast4 || '').trim();
    if (last4 && !/^\d{4}$/.test(last4)) throw new RuleError('VALIDATION', 'תשלום אשראי — 4 הספרות האחרונות חייבות להיות בדיוק 4 ספרות');
    fields.card_last4 = last4 || null;
  } else if (method === 'transfer') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'העברה — מספר אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'standing_order') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'הו"ק — מספר הרשאה / אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'batch') {
    if (!batchNumber || !String(batchNumber).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר מקבץ חובה');
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר אסמכתא חובה');
    fields.batch_number = String(batchNumber).trim();
    fields.reference = String(reference).trim();
  }

  const account = await x.one('SELECT * FROM bank_accounts WHERE id = ?', [bankAccountId]);
  if (!account) throw new NotFoundError(`חשבון בנק ${bankAccountId} לא נמצא`);

  // Friendly guard for a duplicate check number (a voided check released its number, so it's free).
  // חריג אחד (בעלים 25/10): צ׳ק ש"פורק" — "בטל שיוך" הוריד ממנו את כל החשבוניות — מותר להנפיק שוב באותו
  // מספר, **לאותו ספק בלבד** ו**עד שעה** מהפירוק. התשלום החדש מחליף את הישן (שמתבטל ומקושר אליו), כך שתמיד
  // יש צ׳ק חי אחד בכל מספר. ראה reissuableCheck.
  let replaceId = null;
  if (fields.check_number) {
    const dup = await x.one(
      "SELECT id FROM payments WHERE bank_account_id = ? AND check_number = ? AND status <> 'voided'",
      [account.id, fields.check_number],
    );
    if (dup) {
      const re = await reissuableCheck(dup.id, { invoiceIds: isAdvance ? [] : invoiceIds, supplierId: isAdvance ? supplierId : null }, x);
      if (!re.ok) {
        throw new RuleError('CHECK', `מספר צ׳ק ${fields.check_number} כבר קיים בחשבון זה (תשלום #${dup.id}). ${re.why || 'אם זה תיקון — בטל את הצ׳ק הקודם ואז אפשר להשתמש שוב באותו מספר.'}`);
      }
      replaceId = dup.id;
    }
  }

  // Collected for the "paid earlier than terms" Telegram alert, evaluated after commit.
  const termsRows = [];

  const paymentId = await tx(async (t) => {
    let net = 0;
    const lines = [];
    // The supplier family every invoice on this payment must belong to (set by the first one).
    let family = null;
    let familyName = null;

    if (isAdvance) {
      // No lines: the whole amount is on account until an invoice is allocated against it.
      const sup = await t.one('SELECT id, name, status FROM suppliers WHERE id = ?', [supplierId]);
      if (!sup) throw new NotFoundError(`ספק ${supplierId} לא נמצא`);
      if (sup.status !== 'approved') {
        throw new RuleError('R1', `הספק "${sup.name}" אינו מאושר (status=${sup.status}) — תשלום חסום`);
      }
      net = Math.round(Number(advanceAmount));
    }

    for (const invId of isAdvance ? [] : invoiceIds) {
      const inv = await t.one(
        `SELECT i.*, s.status AS supplier_status, s.name AS supplier_name, s.payment_terms AS supplier_terms,
                ba.id AS store_bank_account_id
           FROM invoices i
           JOIN suppliers s ON s.id = i.supplier_id
           JOIN bank_accounts ba ON ba.store_id = i.store_id
          WHERE i.id = ?`,
        [invId],
      );
      if (!inv) throw new NotFoundError(`חשבונית ${invId} לא נמצאה`);
      // docType matters: the alert's clock starts at the earliest TAX invoice, never at a credit note.
      termsRows.push({ supplierId: inv.supplier_id, supplierName: inv.supplier_name, invoiceNumber: inv.invoice_number, invoiceDate: inv.invoice_date, terms: inv.supplier_terms, docType: inv.doc_type });

      // Paying an invoice implicitly approves it: accept "recorded" and "approved_for_payment".
      // R3-blocked (on_hold) and already-paid invoices are still refused.
      if (!['recorded', 'approved_for_payment'].includes(inv.status)) {
        const why = inv.status === 'on_hold' ? 'החשבונית מוחזקת (R3) — שחרר אותה לפני תשלום' : `סטטוס "${inv.status}"`;
        throw new RuleError('R1', `חשבונית #${inv.id}: ${why}`, { invoiceId: inv.id });
      }
      if (inv.supplier_status !== 'approved') {
        throw new RuleError('R1', `הספק "${inv.supplier_name}" אינו מאושר (status=${inv.supplier_status}) — תשלום חסום`, { invoiceId: inv.id });
      }
      if (inv.store_bank_account_id !== account.id) {
        throw new RuleError('ACCOUNT', `חשבונית #${inv.id} משויכת לחשבון בנק אחר — כל החשבוניות בצ׳ק חייבות להיות מאותו חשבון`, { invoiceId: inv.id });
      }
      // One payment settles ONE supplier — you cannot hand a supplier a check that also covers
      // another supplier's invoice. The exception is a supplier FAMILY (a subsidiary and its
      // parent, e.g. טרה under קוקה קולה), which bills separately but is paid together.
      if (family === null) {
        family = new Set(await supplierFamilyIds(inv.supplier_id, t));
        familyName = inv.supplier_name;
      } else if (!family.has(Number(inv.supplier_id))) {
        throw new RuleError(
          'R1',
          `לא ניתן לשלם בתשלום אחד לספקים שונים: "${familyName}" ו-"${inv.supplier_name}". ` +
            'תשלום מרוכז אפשרי רק לספק אחד או לחברת-בת שלו. הנפק תשלום נפרד לכל ספק.',
          { invoiceId: inv.id },
        );
      }

      net += inv.total_amount; // credit notes are negative
      lines.push({ invoiceId: inv.id, amountApplied: inv.total_amount });
    }

    if (net <= 0) {
      throw new RuleError('R5', `נטו לתשלום הוא ${net / 100} ₪ — לא ניתן להנפיק תשלום בסכום אפס או שלילי`);
    }

    // Cash ceiling (חוק צמצום השימוש במזומן) — block cash over the legal limit.
    if (method === 'cash' && config.cashCeilingAgorot > 0 && net > config.cashCeilingAgorot) {
      throw new RuleError(
        'CASH_LIMIT',
        `תשלום במזומן מוגבל ל-${config.cashCeilingAgorot / 100} ₪ לפי חוק צמצום השימוש במזומן. שלם באמצעי אחר.`,
      );
    }

    // הצ׳ק שפורק מתבטל לפני ההכנסה — האינדקס הייחודי (חשבון + מספר צ׳ק, לא מבוטל) מתיר רק צ׳ק חי אחד.
    if (replaceId) {
      await t.run(
        "UPDATE payments SET status = 'voided', voided_at = ?, voided_by = ?, void_reason = 'method_changed', void_alerted = NULL WHERE id = ? AND status = 'issued'",
        [israelNow(), actor?.id ?? null, replaceId],
      );
    }
    const info = await t.run(
      `INSERT INTO payments
         (bank_account_id, method, check_number, reference, payer_name, card_last4, batch_number,
          payment_date, amount, status, supplier_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`,
      [
        account.id,
        method,
        fields.check_number,
        fields.reference,
        fields.payer_name,
        fields.card_last4,
        fields.batch_number,
        paymentDate,
        net,
        // Recorded for an advance (there are no lines to derive it from). For an invoice-backed
        // payment the lines already carry the supplier, so it stays NULL as before.
        isAdvance ? supplierId : null,
        actor.id,
      ],
    );
    const pid = info.lastInsertRowid;

    for (const line of lines) {
      await t.run('INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, ?)', [
        pid,
        line.invoiceId,
        line.amountApplied,
      ]);
      // Concurrency guard against a double payment (double-submit / two racing requests): flip to
      // 'paid' ONLY if the invoice is still payable. Under Postgres READ COMMITTED the second
      // transaction blocks on this row until the first commits, then re-checks the WHERE against
      // the now-'paid' row → 0 rows changed → we abort and roll back the whole payment. (SQLite
      // serializes writers, so it's inherently safe there; this keeps both backends consistent.)
      const upd = await t.run(
        "UPDATE invoices SET status = 'paid', bank_account_id = ? WHERE id = ? AND status IN ('recorded', 'approved_for_payment')",
        [account.id, line.invoiceId],
      );
      if (!upd.changes) {
        throw new RuleError('R2', `חשבונית #${line.invoiceId} כבר שולמה או שונתה בו-זמנית — התשלום בוטל. רענן ונסה שוב.`, { invoiceId: line.invoiceId });
      }
    }

    // R5: with invoices attached the amount must equal their net exactly. An advance has no lines
    // yet, so the rule relaxes to "never allocate more than was paid" — Σ lines ≤ amount.
    const sumRow = await t.one('SELECT COALESCE(SUM(amount_applied),0) AS s FROM payment_lines WHERE payment_id = ?', [pid]);
    if (isAdvance ? Number(sumRow.s) > net : Number(sumRow.s) !== net) {
      throw new RuleError('R5', `אי-התאמה בין סכום הצ׳ק (${net}) לסכום השורות (${sumRow.s})`);
    }

    await logAction(
      { userId: actor.id, action: 'payment.create', entityType: 'payment', entityId: pid, details: { method, ...fields, amount: net, invoiceIds, advance: isAdvance || undefined, supplierId: isAdvance ? supplierId : undefined, replaces: replaceId || undefined } },
      t,
    );
    if (replaceId) {
      // הצ׳ק הישן מצביע על התשלום שהחליף אותו ("שינוי אמצעי תשלום" + קישור) — בדף הצ׳קים המבוטלים הוא לא נרדף.
      await t.run('UPDATE payments SET void_link_payment_id = ? WHERE id = ?', [pid, replaceId]);
      await logAction({ userId: actor.id, action: 'payment.reissued', entityType: 'payment', entityId: replaceId, details: { checkNumber: fields.check_number, replacedBy: pid } }, t);
    }
    return pid;
  });

  // Best-effort Telegram push if any invoice was paid earlier than its supplier's terms (§7).
  try {
    const alerts = earlyPaymentAlerts(termsRows, paymentDate);
    if (alerts.length) {
      const lines = alerts.map(
        (a) => `• ${a.supplierName} · חשבונית מס ${a.invoiceNumber}: שולם ${a.actualDays} ימים מתאריך החשבונית (תנאי ${a.termsDays} ימים) — מוקדם ב-${a.earlyDays} ימים`,
      );
      notify(`⏱️ <b>תשלום מוקדם מתנאי התשלום</b>\n${lines.join('\n')}`);
    }
  } catch { /* alerts are best-effort */ }

  return getPaymentDetail(paymentId, x);
}

// Per-method identifier validation → the columns to store. Shared shape with createPayment.
function methodIdentifierFields({ method, checkNumber, reference, payerName, cardLast4, batchNumber }) {
  const fields = { check_number: null, reference: null, payer_name: null, card_last4: null, batch_number: null };
  if (method === 'check') {
    if (!checkNumber || !String(checkNumber).trim()) throw new RuleError('CHECK', 'לא ניתן להנפיק צ׳ק ללא מספר צ׳ק');
    fields.check_number = String(checkNumber).trim();
  } else if (method === 'cash') {
    if (!payerName || !String(payerName).trim()) throw new RuleError('VALIDATION', 'תשלום מזומן — שם המשלם חובה');
    fields.payer_name = String(payerName).trim();
  } else if (method === 'credit') {
    const last4 = String(cardLast4 || '').trim();
    if (last4 && !/^\d{4}$/.test(last4)) throw new RuleError('VALIDATION', 'תשלום אשראי — 4 הספרות האחרונות חייבות להיות בדיוק 4 ספרות');
    fields.card_last4 = last4 || null;
  } else if (method === 'transfer') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'העברה — מספר אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'standing_order') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'הו"ק — מספר הרשאה / אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'batch') {
    if (!batchNumber || !String(batchNumber).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר מקבץ חובה');
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר אסמכתא חובה');
    fields.batch_number = String(batchNumber).trim();
    fields.reference = String(reference).trim();
  }
  return fields;
}

/**
 * Edit an existing payment's method / identifier / payment date. The amount and the invoices it is
 * applied to are NOT changed here (that would re-open R5 and the invoice paid-state); to re-target
 * invoices, void this payment and issue a new one. A voided payment can't be edited.
 */
export async function updatePayment(id, input, actor, x = getExecutor()) {
  const existing = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!existing) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  if (existing.status === 'voided') throw new RuleError('VALIDATION', 'לא ניתן לערוך תשלום מבוטל');
  const method = input.method || existing.method;
  if (!METHODS.includes(method)) throw new RuleError('VALIDATION', `אמצעי תשלום לא תקין: ${method}`);
  const paymentDate = input.paymentDate || existing.payment_date;
  if (!paymentDate) throw new RuleError('VALIDATION', 'תאריך תשלום חובה');
  const fields = methodIdentifierFields({ ...input, method });

  // Check number stays unique within the bank account — among LIVE payments only (a voided check
  // released its number), and excluding this same payment.
  if (fields.check_number) {
    const dup = await x.one(
      "SELECT id FROM payments WHERE bank_account_id = ? AND check_number = ? AND status <> 'voided' AND id <> ?",
      [existing.bank_account_id, fields.check_number, id],
    );
    if (dup) throw new RuleError('VALIDATION', `מספר צ׳ק ${fields.check_number} כבר קיים בחשבון זה`);
  }

  // Optional: re-target the invoices this payment applies to (e.g. add a credit note so the net
  // becomes the real check amount). Allowed only for an issued, not-bank-matched payment. The
  // amount is recomputed from the selected invoices (R5) — never edited to an arbitrary value.
  const retarget = Array.isArray(input.invoiceIds) && input.invoiceIds.length > 0;

  await tx(async (t) => {
    if (retarget) {
      if (existing.status !== 'issued') throw new RuleError('VALIDATION', 'שינוי החשבוניות המשויכות אפשרי רק לתשלום שהונפק (לא נפרע/מבוטל)');
      const matched = await t.one('SELECT 1 AS m FROM bank_transactions WHERE matched_payment_id = ? LIMIT 1', [id]);
      if (matched) throw new RuleError('VALIDATION', 'התשלום מותאם לתנועת בנק — בטל את ההתאמה לפני שינוי החשבוניות');

      const curIds = new Set((await t.many('SELECT invoice_id FROM payment_lines WHERE payment_id = ?', [id])).map((r) => Number(r.invoice_id)));
      const newIds = [...new Set(input.invoiceIds.map(Number).filter(Boolean))];
      let net = 0;
      const lines = [];
      let family = null;
      let familyName = null;
      for (const invId of newIds) {
        const inv = await t.one(
          `SELECT i.*, s.status AS supplier_status, s.name AS supplier_name, ba.id AS store_bank_account_id
             FROM invoices i JOIN suppliers s ON s.id = i.supplier_id JOIN bank_accounts ba ON ba.store_id = i.store_id
            WHERE i.id = ?`,
          [invId],
        );
        if (!inv) throw new NotFoundError(`חשבונית ${invId} לא נמצאה`);
        const okStatus = ['recorded', 'approved_for_payment'].includes(inv.status) || (inv.status === 'paid' && curIds.has(invId));
        if (!okStatus) throw new RuleError('R1', `חשבונית #${inv.id}: סטטוס "${inv.status}" — לא ניתן לשייך לתשלום`, { invoiceId: inv.id });
        if (inv.supplier_status !== 'approved') throw new RuleError('R1', `הספק "${inv.supplier_name}" אינו מאושר — תשלום חסום`, { invoiceId: inv.id });
        if (inv.store_bank_account_id !== existing.bank_account_id) throw new RuleError('ACCOUNT', `חשבונית #${inv.id} משויכת לחשבון בנק אחר`, { invoiceId: inv.id });
        // Same one-supplier-family rule as createPayment — a re-target must not smuggle in a
        // second supplier's invoice.
        if (family === null) {
          family = new Set(await supplierFamilyIds(inv.supplier_id, t));
          familyName = inv.supplier_name;
        } else if (!family.has(Number(inv.supplier_id))) {
          throw new RuleError(
            'R1',
            `לא ניתן לשלם בתשלום אחד לספקים שונים: "${familyName}" ו-"${inv.supplier_name}".`,
            { invoiceId: inv.id },
          );
        }
        net += inv.total_amount;
        lines.push({ invoiceId: inv.id, amountApplied: inv.total_amount });
      }
      if (net <= 0) throw new RuleError('R5', `נטו לתשלום הוא ${net / 100} ₪ — לא ניתן לתשלום בסכום אפס או שלילי`);
      if (method === 'cash' && config.cashCeilingAgorot > 0 && net > config.cashCeilingAgorot) {
        throw new RuleError('CASH_LIMIT', `תשלום במזומן מוגבל ל-${config.cashCeilingAgorot / 100} ₪ לפי חוק צמצום השימוש במזומן.`);
      }
      // Invoices dropped from this payment revert to unpaid ('recorded'); kept/added become 'paid'.
      await t.run('DELETE FROM payment_lines WHERE payment_id = ?', [id]);
      for (const l of lines) {
        await t.run('INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, ?)', [id, l.invoiceId, l.amountApplied]);
      }
      // Recompute every invoice this payment touched — dropped ones AND kept ones. Since R8 an
      // invoice may be covered by other payments too, so "dropped from this check" no longer
      // means "unpaid": syncInvoicePaidStatus is the only thing allowed to decide that.
      for (const invId of new Set([...curIds, ...newIds])) {
        await syncInvoicePaidStatus(invId, existing.bank_account_id, t);
      }
      await t.run(
        `UPDATE payments SET method = ?, check_number = ?, reference = ?, payer_name = ?, card_last4 = ?, batch_number = ?, payment_date = ?, amount = ? WHERE id = ?`,
        [method, fields.check_number, fields.reference, fields.payer_name, fields.card_last4, fields.batch_number, paymentDate, net, id],
      );
    } else {
      // Plain edit (no retarget): the amount is unchanged, but the method may have switched to
      // cash — enforce the cash ceiling here too, or a large check could be relabelled 'cash'
      // above the legal limit without recomputing.
      if (method === 'cash' && config.cashCeilingAgorot > 0 && existing.amount > config.cashCeilingAgorot) {
        throw new RuleError('CASH_LIMIT', `תשלום במזומן מוגבל ל-${config.cashCeilingAgorot / 100} ₪ לפי חוק צמצום השימוש במזומן.`);
      }
      await t.run(
        `UPDATE payments SET method = ?, check_number = ?, reference = ?, payer_name = ?, card_last4 = ?, batch_number = ?, payment_date = ? WHERE id = ?`,
        [method, fields.check_number, fields.reference, fields.payer_name, fields.card_last4, fields.batch_number, paymentDate, id],
      );
    }
  });
  await logAction({ userId: actor?.id ?? null, action: 'payment.update', entityType: 'payment', entityId: id, details: { method, ...fields, paymentDate, retarget } }, x);
  return getPaymentDetail(id, x);
}

/** Manually mark a check as cleared (stage-1 manual reconciliation; R7 automates this in stage 2). */
export async function markCleared(id, clearedDate, actor, x = getExecutor()) {
  const payment = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  if (payment.status === 'voided') throw new RuleError('R', 'צ׳ק מבוטל — לא ניתן לסמן כנפרע');

  await x.run("UPDATE payments SET status = 'cleared', cleared_date = ? WHERE id = ?", [
    clearedDate || israelToday(),
    id,
  ]);
  await logAction({ userId: actor.id, action: 'payment.clear', entityType: 'payment', entityId: id, details: { clearedDate } }, x);
  return getPaymentDetail(id, x);
}

/** Revert a manually-cleared check back to 'issued' (undo an accidental "mark cleared"). */
export async function markIssued(id, actor, x = getExecutor()) {
  const payment = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  if (payment.status === 'voided') throw new RuleError('R', 'צ׳ק מבוטל — לא ניתן לשנות סטטוס');
  if (payment.status === 'issued') return getPaymentDetail(id, x);
  await x.run("UPDATE payments SET status = 'issued', cleared_date = NULL WHERE id = ?", [id]);
  await logAction({ userId: actor.id, action: 'payment.unclear', entityType: 'payment', entityId: id }, x);
  return getPaymentDetail(id, x);
}

/** Void a check. Reverts its invoices back to approved_for_payment. Owner-only. */
/**
 * Void a check WITH the structured reason the צ'קים מבוטלים page is built on.
 *
 * The reason is asked for, not typed, because each one carries a different follow-up and the page
 * cannot chase what it cannot classify (see services/voidedChecks.js):
 *   not_collected     — safe only once six months have passed since the check's date;
 *   cashed_for_salary — must be matched to the Z-closing cash expense that paid it at the till;
 *   method_changed    — must link to the payment that replaced it;
 *   row_cancelled     — must link to the row it belonged to.
 *
 * `reason` may be omitted for a plain void (an older caller, or a correction with nothing to
 * follow up); the check then still appears on the page, with no reason-specific chase.
 *
 * @param {{reason?:string, cashExpenseId?:number, linkPaymentId?:number, linkInvoiceId?:number, note?:string}} details
 */
export async function voidPaymentWithReason(id, details, actor, x = getExecutor()) {
  const { VOID_REASON_VALUES } = await import('./voidedChecks.js');
  const reason = details?.reason || null;
  if (reason && !VOID_REASON_VALUES.includes(reason)) {
    throw new RuleError('VALIDATION', 'סיבת ביטול לא תקינה');
  }
  const payment = await voidPayment(id, actor, details?.note || reason, x);
  await x.run(
    `UPDATE payments
        SET void_reason = ?, voided_at = ?, voided_by = ?,
            void_cash_expense_id = ?, void_link_payment_id = ?, void_link_invoice_id = ?,
            void_alerted = NULL
      WHERE id = ?`,
    [
      reason,
      israelNow(),
      actor?.id ?? null,
      details?.cashExpenseId ? Number(details.cashExpenseId) : null,
      details?.linkPaymentId ? Number(details.linkPaymentId) : null,
      details?.linkInvoiceId ? Number(details.linkInvoiceId) : null,
      id,
    ],
  );
  return getPaymentDetail(id, x);
}

export async function voidPayment(id, actor, reason = null, x = getExecutor()) {
  if (!userCan(actor, 'void_payment')) throw new AuthError('ביטול צ׳ק — נדרשת הרשאת ביטול תשלום');
  const payment = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  // Idempotency guard: voiding an already-voided check would re-revert its invoices to
  // approved_for_payment, silently un-doing any later state (e.g. re-paid on a new check).
  if (payment.status === 'voided') throw new RuleError('R', 'הצ׳ק כבר בוטל');
  // A payment may be voided ONLY while it is still 'issued' and NOT reconciled to the bank —
  // once the money went through it is irreversible; the correction there is a stop-payment / a
  // manual credit, not a void. The bank-match check comes first (a matched payment is also
  // 'cleared', and its message is the more actionable one). To void either, first unmatch and
  // revert the clear (markIssued).
  const matched = await x.one('SELECT 1 AS m FROM bank_transactions WHERE matched_payment_id = ? LIMIT 1', [id]);
  if (matched) throw new RuleError('R', 'התשלום הותאם לתנועת בנק — בטל את ההתאמה תחילה, ורק אז ניתן לבטל.');
  if (payment.status !== 'issued') throw new RuleError('R', 'תשלום שנפרע — לא ניתן לבטל (הכסף כבר עבר). שחרר את הפירעון תחילה אם זו טעות.');

  await tx(async (t) => {
    const lines = await t.many('SELECT invoice_id FROM payment_lines WHERE payment_id = ?', [id]);
    // Void FIRST, then recompute: an invoice may be covered by several payments now (R8), so
    // whether it stays 'paid' depends on the allocations that REMAIN live — blindly reverting it
    // to approved_for_payment would re-open an invoice the other checks still cover.
    await t.run(
      "UPDATE payments SET status = 'voided', voided_at = COALESCE(voided_at, ?), voided_by = COALESCE(voided_by, ?) WHERE id = ?",
      [israelNow(), actor?.id ?? null, id],
    );
    for (const line of lines) {
      await syncInvoicePaidStatus(line.invoice_id, null, t);
    }
    await logAction({ userId: actor.id, action: 'payment.void', entityType: 'payment', entityId: id, details: { reason } }, t);
  });

  return getPaymentDetail(id, x);
}

export async function getPaymentDetail(id, x = getExecutor()) {
  const payment = await x.one(
    `SELECT p.*, ba.display_name AS bank_account_name,
            CASE WHEN mt.matched_payment_id IS NOT NULL THEN 1 ELSE 0 END AS auto_cleared
       FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
       LEFT JOIN (SELECT DISTINCT matched_payment_id FROM bank_transactions WHERE matched_payment_id IS NOT NULL) mt
              ON mt.matched_payment_id = p.id
      WHERE p.id = ?`,
    [id],
  );
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  payment.lines = await x.many(
    `SELECT pl.*, i.invoice_number, i.doc_type, i.invoice_date, s.name AS supplier_name
       FROM payment_lines pl
       JOIN invoices i ON i.id = pl.invoice_id
       JOIN suppliers s ON s.id = i.supplier_id
      WHERE pl.payment_id = ?`,
    [id],
  );
  return payment;
}

const ddmmyyyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};
const ddmmyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : '';
};
/** "1,534.00" — ספרות בלבד; ה-₪ מודפס מראש ליד תיבת הסכום. */
export function checkDigits(agorot) {
  const a = Math.abs(Math.round(Number(agorot) || 0));
  return `${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * כל מה שהדפסת צ׳ק על טופס InterCheck צריכה (`lib/checkForm.js`, `views/payments/print.ejs`). בעלים 29/10:
 * "שלמו ל" = שם הספק כמו באפליקציה · "מס׳ ספק" = ח.פ./ע.מ. שלו · "ניכוי מס במקור" = ריק (סה"כ לתשלום = סה"כ).
 * צ׳ק מבוטל לא מודפס — הוא כבר לא כסף.
 */
export async function getCheckPrintData(id, x = getExecutor()) {
  const payment = await getPaymentDetail(id, x);
  if (payment.method !== 'check') {
    throw new RuleError('PRINT', 'הדפסת צ׳ק זמינה רק לתשלום מסוג צ׳ק');
  }
  if (payment.status === 'voided') {
    throw new RuleError('PRINT', 'הצ׳ק הזה מבוטל — לא מדפיסים צ׳ק מבוטל');
  }
  const account = await x.one(
    `SELECT ba.*, c.name AS company_name, c.tax_id AS company_tax_id
       FROM bank_accounts ba JOIN companies c ON c.id = ba.company_id
      WHERE ba.id = ?`,
    [payment.bank_account_id],
  );

  const docs = await x.many(
    `SELECT pl.amount_applied, i.id AS invoice_id, i.invoice_number, i.invoice_date, i.doc_type, i.total_amount, i.supplier_id
       FROM payment_lines pl JOIN invoices i ON i.id = pl.invoice_id
      WHERE pl.payment_id = ?
      ORDER BY i.invoice_date, i.id`,
    [id],
  );
  const lines = docs.map((d) => ({
    text: `${d.doc_type === 'credit_note' ? 'זיכוי' : 'חשבונית'} ${d.invoice_number} · ${ddmmyy(d.invoice_date)}`
      + (Number(d.amount_applied) !== Number(d.total_amount) ? ' (חלקי)' : ''),
    amount: Number(d.amount_applied),
  }));
  // מקדמה (R8) — תשלום בלי חשבוניות: שורה אחת שאומרת מה זה.
  if (!lines.length) lines.push({ text: 'מקדמה על חשבון', amount: Number(payment.amount) });

  // המוטב: הספק של התשלום. חברת-אם וחברות-בת שמשולמות יחד (קוקה קולה + טרה) — הצ׳ק לחברת-האם.
  const supIds = [...new Set([payment.supplier_id, ...docs.map((d) => d.supplier_id)].filter(Boolean).map(Number))];
  const sups = supIds.length
    ? await x.many(`SELECT id, name, tax_id, parent_supplier_id FROM suppliers WHERE id IN (${supIds.map(() => '?').join(', ')})`, supIds)
    : [];
  const payee = sups.find((s) => Number(s.id) === Number(payment.supplier_id))
    || sups.find((s) => !s.parent_supplier_id || !supIds.includes(Number(s.parent_supplier_id)))
    || sups[0] || null;

  const printed = await x.one(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.check_printed' AND entity_type = 'payment' AND entity_id = ?`,
    [id],
  );

  return {
    payment,
    account,
    payee: payee ? payee.name : '',
    payeeTaxId: payee?.tax_id || '',
    // רשימת כל השמות (לתצוגה על המסך — כשהתשלום מכסה חברה-אם וחברת-בת).
    payees: sups.map((s) => s.name),
    lines,
    total: Number(payment.amount),
    amountWords: amountToHebrewWords(payment.amount),
    amountDigits: checkDigits(payment.amount),
    checkDate: ddmmyyyy(payment.payment_date),
    letterDate: ddmmyyyy(israelDayOf(payment.created_at) || payment.payment_date),
    printCount: Number(printed?.n) || 0,
  };
}

/** "נשלח להדפסה" — נרשם ביומן, כדי שהדפסה חוזרת של אותו צ׳ק תציג אזהרה (צ׳ק כפול = כסף כפול). */
export async function logCheckPrinted(id, actor, x = getExecutor()) {
  const payment = await getPaymentDetail(id, x);
  if (payment.method !== 'check' || payment.status === 'voided') throw new RuleError('PRINT', 'אין מה להדפיס');
  await logAction(
    { userId: actor?.id ?? null, action: 'payment.check_printed', entityType: 'payment', entityId: Number(id), details: { checkNumber: payment.check_number } },
    x,
  );
}

/** העברה ומקבץ — מוצגים בדף "העברות בנקאיות", לא בטבלת המרקורים (בעלים 21/10: "העברות שייך להעברות בנקאיות"). */
export const TRANSFER_METHODS = ['transfer', 'batch'];

export async function listPayments({ status = null, companyId = null, storeId = null, scope = null, hideAuthority = false, methods = null, excludeMethods = null } = {}, x = getExecutor()) {
  const where = [];
  const params = [];
  if (Array.isArray(methods) && methods.length) {
    where.push(`p.method IN (${methods.map(() => '?').join(', ')})`);
    params.push(...methods);
  }
  if (Array.isArray(excludeMethods) && excludeMethods.length) {
    where.push(`p.method NOT IN (${excludeMethods.map(() => '?').join(', ')})`);
    params.push(...excludeMethods);
  }
  // מרקורים: תשלום שסומן "לרשות" יוצא מהטבלה ומופיע רק ב"תשלומים לרשויות" (בעלים 21/10). לפני "עדכן מסד נתונים"
  // אין עמודה — אז אין גם סימונים, ולא מסננים.
  if (hideAuthority && await authorityPaymentsReady(x)) where.push('p.authority IS NULL');
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }
  if (companyId) {
    where.push('ba.company_id = ?');
    params.push(companyId);
  }
  if (storeId) {
    where.push('ba.store_id = ?');
    params.push(storeId);
  }
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  if (sc.sql) { where.push(sc.sql.replace(/^ AND /, '')); params.push(...sc.params); }
  const sql = `SELECT p.*, ba.display_name AS bank_account_name,
                      c.name AS company_name, st.name AS store_name,
                      CASE WHEN mt.matched_payment_id IS NOT NULL THEN 1 ELSE 0 END AS auto_cleared
                 FROM payments p
                 JOIN bank_accounts ba ON ba.id = p.bank_account_id
                 JOIN companies c ON c.id = ba.company_id
                 JOIN stores st ON st.id = ba.store_id
                 LEFT JOIN (SELECT DISTINCT matched_payment_id FROM bank_transactions WHERE matched_payment_id IS NOT NULL) mt
                        ON mt.matched_payment_id = p.id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY p.id DESC`;
  const rows = await x.many(sql, params);
  // "מס׳ אסמכתה" במרקורים (בעלים 22/10): האסמכתה של תנועת הבנק שסגרה את התשלום. שאילתה שטוחה + חיבור ב-JS
  // (pg-mem לא אוהב תת-שאילתה מתואמת בתוך ה-JOIN שלמעלה).
  if (rows.length) {
    const refs = await x.many(
      "SELECT matched_payment_id, raw_reference FROM bank_transactions WHERE matched_payment_id IS NOT NULL AND raw_reference IS NOT NULL AND raw_reference <> '' ORDER BY id",
      [],
    );
    const byPayment = new Map();
    for (const r of refs) if (!byPayment.has(Number(r.matched_payment_id))) byPayment.set(Number(r.matched_payment_id), r.raw_reference);
    for (const r of rows) r.bank_reference = byPayment.get(Number(r.id)) || null;
  }
  return rows;
}

/** Lookup payments by (last digits of) check number / transfer reference / batch number. */
export async function lookupChecks(query, scope = null, x = getExecutor(), { dateFrom = null, dateTo = null } = {}) {
  const terms = parseSearchTerms(query);
  if (!terms.length) return [];
  const m = anyTermLike(terms, ['p.check_number', 'p.reference', 'p.batch_number']);
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  // טווח התאריכים של לוח הבקרה: לצ׳ק — תאריך הפירעון (payment_date).
  let range = '';
  const rangeParams = [];
  if (dateFrom) { range += ' AND p.payment_date >= ?'; rangeParams.push(dateFrom); }
  if (dateTo) { range += ' AND p.payment_date <= ?'; rangeParams.push(dateTo); }
  // Correlated subquery for one supplier name -> one row per payment, portable across SQLite/Postgres.
  return x.many(
    `SELECT p.id, p.method, p.check_number, p.reference, p.batch_number,
            p.payer_name, p.card_last4,
            p.payment_date, p.amount, p.status,
            ba.display_name AS bank_account_name,
            (SELECT s.name FROM payment_lines pl
               JOIN invoices i ON i.id = pl.invoice_id
               JOIN suppliers s ON s.id = i.supplier_id
              WHERE pl.payment_id = p.id
              ORDER BY pl.id LIMIT 1) AS supplier_name
       FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
      WHERE ${m.sql}${sc.sql}${range}
      ORDER BY p.id DESC`,
    [...m.params, ...sc.params, ...rangeParams],
  );
}

/**
 * שלם כמה חשבוניות בתשלום אחד — **הביטוי היחיד** של הכלל הזה.
 *
 * הלוגיקה הזו ישבה inline ב-`POST /invoices/pay-batch`, ודף התאמת הבנק צריך בדיוק אותה: גם שם
 * סוגרים כמה חשבוניות בתשלום אחד, רק שהסכום אינו נבחר אלא **נקבע בידי הבנק**. שכפולה היה יוצר שני
 * ביטויים של R8 שנפרדים בשקט — ובפרט את סדר הזיכויים, שטעות בו היא קיזוז שגוי ולא שגיאה גלויה.
 *
 * `amount` (אגורות) = כמה כסף באמת שולם. `null` = הסכום נגזר מהחשבוניות (המסלול הרגיל, R5).
 * כשהוא נתון — התשלום נרשם כתשלום לספק ואז **מוקצה** על פני החשבוניות, וזה מה שמאפשר תשלום חלקי.
 *
 * @returns {Promise<{payment:object, allocated:number, stillOpen:number}>}
 */
export async function payInvoices(input, actor, x = getExecutor()) {
  const { invoiceIds = [], supplierId = null, amount = null, ...payInput } = input;
  const ids = [].concat(invoiceIds).map(Number).filter(Boolean);
  if (ids.length === 0) throw new RuleError('R', 'לא נבחרו חשבוניות לתשלום');

  const { invoiceAllocation, paymentAllocation, allocateInvoiceToPayments } = await import('./allocations.js');

  // מה שעוד **פתוח** בחשבוניות — לא ערכן הנקוב — הוא מה שהתשלום הבא יכול לכסות, כי תשלום קודם
  // כבר לקח את חלקו.
  let remaining = 0;
  let faceValue = 0;
  for (const invId of ids) {
    const a = await invoiceAllocation(invId, x);
    remaining += a.open;
    faceValue += a.total;
  }
  const split = amount != null || remaining !== faceValue;

  if (!split) {
    const payment = await createPayment({ ...payInput, invoiceIds: ids }, actor, x);
    return { payment, allocated: faceValue, stillOpen: 0 };
  }

  if (remaining <= 0) throw new RuleError('R8', 'החשבוניות המסומנות כבר משולמות במלואן');
  // סכום מעל היתרה הפתוחה הוא **טעות הקלדה, לא הוראה** — מסרבים במקום לקצץ בשקט, אחרת נרשם
  // תשלום שאיש לא התכוון לבצע.
  if (amount != null && amount > remaining) {
    throw new RuleError(
      'R8',
      `לא ניתן לשלם מעבר ליתרה. היתרה הפתוחה בחשבוניות המסומנות היא ${fromAgorot(remaining)} ₪ ` +
        `והוזן ${fromAgorot(amount)} ₪. תקן את הסכום ונסה שוב.`,
    );
  }
  const payAmount = amount == null ? remaining : amount;
  if (payAmount <= 0) throw new RuleError('R8', 'סכום התשלום חייב להיות חיובי');

  const payment = await createPayment(
    { ...payInput, invoiceIds: [], supplierId, amount: payAmount }, actor, x,
  );

  // 🔴 **זיכויים ראשונים.** שורת זיכוי שלילית, ולכן החלתה לפני החשבוניות **מגדילה** את מה שהתשלום
  // יכול לבלוע (₪5,000 עם זיכוי ₪1,000− מכסים ₪6,000 חשבונית). בסדר ההפוך התשלום היה מתמלא
  // מהחשבונית, הזיכוי היה נדחק לתשלום מאוחר יותר, והקיזוז יוצא שגוי — בשקט. זיכוי נכנס בשלמותו
  // לתשלום אחד ואינו מתפצל.
  const ordered = [];
  for (const invId of ids) {
    const a = await invoiceAllocation(invId, x);
    ordered.push({ invId, credit: a.total < 0 });
  }
  ordered.sort((p1, p2) => Number(p2.credit) - Number(p1.credit));

  for (const row of ordered) {
    const a = await invoiceAllocation(row.invId, x);
    const done = a.total < 0 ? a.open >= 0 : a.open <= 0;
    if (done) continue;
    if (a.total > 0 && (await paymentAllocation(payment.id, x)).unallocated <= 0) break;
    await allocateInvoiceToPayments(row.invId, [{ paymentId: payment.id }], actor, x);
  }

  let stillOpen = 0;
  for (const invId of ids) stillOpen += (await invoiceAllocation(invId, x)).open;
  return { payment, allocated: payAmount, stillOpen };
}
