import { formatIls } from './money.js';
import { arnonaMonth, arnonaPeriodLabel } from './arnona.js';

// Build a detailed, human-readable "old → new" summary for an edit awaiting approval.
// Only changed fields are listed, in Hebrew, with money/labels formatted.

const DOC_LABELS = { tax_invoice: 'חשבונית מס', tax_invoice_receipt: 'חשבונית מס/קבלה', credit_note: 'זיכוי', arnona: 'חשבון ארנונה' };

function line(label, oldV, newV) {
  if (String(oldV ?? '') === String(newV ?? '')) return null;
  return `${label}: ${oldV ?? '—'} ← ${newV ?? '—'}`;
}

/**
 * האם עריכת חשבונית (fields = קלט updateInvoice) כבר תואמת את החשבונית כפי שהיא עכשיו — אין מה לשנות.
 * משמש לבקשה שלא שינתה כלום (לא נשלחת לאישור) ולבקשה ממתינה שהשינוי שלה כבר נעשה בדרך אחרת (נסגרת לבד —
 * services/changeRequests.js#closeSupersededRequests; בעלים 25/10: "שיניתי אותם אחרי שהם הוחזקו — איך מבטלים?").
 */
export function invoiceEditMatches(cur, f) {
  const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
  const base = Number(f.supplierId) === Number(cur.supplier_id)
    && Number(f.storeId) === Number(cur.store_id)
    && same(f.docType, cur.doc_type);
  // 🏛️ ארנונה: המספר והתאריך נגזרים (השדות שלהם מושבתים בטופס) — משווים נכס, מסלקה, תקופה וסה"כ.
  if (f.docType === 'arnona') {
    return base
      && same(f.propertyNumber, cur.property_number)
      && same(f.clearingNumber, cur.clearing_number)
      && arnonaMonth(f.periodFrom) === arnonaMonth(cur.period_from)
      && arnonaMonth(f.periodTo) === arnonaMonth(cur.period_to)
      && Math.abs(Number(f.amountBeforeVat) || 0) + Math.abs(Number(f.vatAmount) || 0)
        === Math.abs(Number(cur.total_amount) || 0);
  }
  return base
    && same(f.invoiceNumber, cur.invoice_number)
    && same(f.invoiceDate, cur.invoice_date)
    && same(f.allocationNumber, cur.allocation_number)
    && Math.abs(Number(f.amountBeforeVat) || 0) === Math.abs(Number(cur.amount_before_vat) || 0)
    && Math.abs(Number(f.vatAmount) || 0) === Math.abs(Number(cur.vat_amount) || 0);
}

/** current = getInvoiceDetail row (agorot, magnitudes signed); fields = updateInvoice input (agorot magnitudes). */
export function describeInvoice(current, fields) {
  const arnona = fields.docType === 'arnona';
  const rows = (arnona
    ? [
      line('סוג', DOC_LABELS[current.doc_type] || current.doc_type, DOC_LABELS.arnona),
      line('מס׳ נכס', current.property_number || '—', String(fields.propertyNumber ?? '').trim() || '—'),
      line('מס׳ מסלקה', current.clearing_number || '—', String(fields.clearingNumber ?? '').trim() || '—'),
      line('תקופה', arnonaPeriodLabel(current.period_from, current.period_to) || '—',
        arnonaPeriodLabel(fields.periodFrom, fields.periodTo) || '—'),
      line('סכום', formatIls(Math.abs(current.total_amount)),
        formatIls(Math.abs(fields.amountBeforeVat || 0) + Math.abs(fields.vatAmount || 0))),
    ]
    : [
      line('מספר חשבונית', current.invoice_number, fields.invoiceNumber),
      line('תאריך', current.invoice_date, fields.invoiceDate),
      line('מספר הקצאה', current.allocation_number || '—', fields.allocationNumber || '—'),
      line('סוג', DOC_LABELS[current.doc_type] || current.doc_type, DOC_LABELS[fields.docType] || fields.docType),
      line('לפני מע"מ', formatIls(Math.abs(current.amount_before_vat)), formatIls(Math.abs(fields.amountBeforeVat))),
      line('מע"מ', formatIls(Math.abs(current.vat_amount)), formatIls(Math.abs(fields.vatAmount))),
    ]).filter(Boolean);
  // מספר החשבונית והספק — לא המזהה הפנימי (#1001 לא אמר לבעלים כלום; בעלים 25/10). הקישור לחשבונית — בדף האישורים.
  const head = `חשבונית ${current.invoice_number || '#' + current.id} · ${current.supplier_name || ''}`.trim();
  return rows.length ? `${head}:\n` + rows.join('\n') : `${head}: ללא שינוי`;
}

/** current = getSupplier row; fields = updateSupplier input (name, taxId, phone, email, contactName, contactPhone, notes). */
export function describeSupplier(current, fields) {
  const rows = [
    line('שם', current.name, fields.name),
    line('ח.פ.', current.tax_id || '—', fields.taxId || '—'),
    line('טלפון', current.phone || '—', fields.phone || '—'),
    line('מייל', current.email || '—', fields.email || '—'),
    line('איש קשר', current.contact_name || '—', fields.contactName || '—'),
    line('טלפון איש קשר', current.contact_phone || '—', fields.contactPhone || '—'),
  ].filter(Boolean);
  return rows.length ? `ספק #${current.id} (${current.name}):\n` + rows.join('\n') : `ספק #${current.id}: ללא שינוי`;
}

/** current = getTransaction row (amount agorot); fields = editTransaction input (amount agorot). */
export function describeBankTxn(current, fields) {
  const rows = [
    line('תאריך', current.txn_date, fields.txnDate),
    line('סכום', formatIls(current.amount), formatIls(fields.amount)),
    line('תיאור', current.description || '—', fields.description || '—'),
    line('אסמכתא', current.raw_reference || '—', fields.rawReference || '—'),
  ].filter(Boolean);
  return rows.length ? `תנועת בנק #${current.id}:\n` + rows.join('\n') : `תנועת בנק #${current.id}: ללא שינוי`;
}
