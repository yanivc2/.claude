import { getExecutor, nowTs } from '../db/adapter.js';
import { RuleError } from '../lib/errors.js';
import { extractFields } from '../lib/ocrExtract.js';
import { recognizeWithTesseract } from '../ocr/tesseract.js';
import { localPath } from '../lib/storage.js';
import { getInvoice } from './invoices.js';
import { logAction } from './audit.js';

// Stage 3 — read an invoice image and compare the extracted fields to what was typed (§3/§8).
// OCR never overwrites human input; it is stored separately and surfaced for verification.

/**
 * Run OCR on an invoice's image, extract candidate fields, and persist the result.
 */
export async function runOcrForInvoice(
  invoiceId,
  actor,
  { recognize = recognizeWithTesseract, provider = 'tesseract' } = {},
  x = getExecutor(),
) {
  const invoice = await getInvoice(invoiceId, x);
  if (!invoice.image_path) throw new RuleError('OCR', 'לחשבונית אין תמונה לסריקה');
  if (/\.pdf$/i.test(invoice.image_path)) {
    throw new RuleError('OCR', 'OCR על PDF אינו נתמך בשלב 3 — צרף תמונה (JPG/PNG)');
  }

  const imagePath = await localPath(invoice.image_path);
  const rawText = await recognize(imagePath);
  const extracted = extractFields(rawText);

  await x.run(
    `INSERT INTO invoice_ocr (invoice_id, raw_text, extracted, provider)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(invoice_id) DO UPDATE SET
       raw_text = excluded.raw_text, extracted = excluded.extracted,
       provider = excluded.provider, ran_at = ?`,
    [invoiceId, rawText, JSON.stringify(extracted), provider, nowTs()],
  );

  await logAction(
    { userId: actor?.id ?? null, action: 'invoice.ocr', entityType: 'invoice', entityId: invoiceId, details: { provider } },
    x,
  );
  return { rawText, extracted };
}

/** Stored OCR result for an invoice, or null. */
export async function getOcr(invoiceId, x = getExecutor()) {
  const row = await x.one('SELECT * FROM invoice_ocr WHERE invoice_id = ?', [invoiceId]);
  if (!row) return null;
  return { ...row, extracted: row.extracted ? JSON.parse(row.extracted) : null };
}

/**
 * Compare the stored OCR extraction against the typed invoice values (§3/§8).
 * @returns {{rows: Array<{field,label,typed,ocr,status}>, hasMismatch: boolean}|null}
 */
export async function compareToInvoice(invoiceId, x = getExecutor()) {
  const ocr = await getOcr(invoiceId, x);
  if (!ocr || !ocr.extracted) return null;
  const invoice = await getInvoice(invoiceId, x);
  const e = ocr.extracted;
  const magnitude = (n) => (n == null ? null : Math.abs(n));

  const spec = [
    { field: 'allocation_number', label: 'מספר הקצאה', typed: invoice.allocation_number, ocr: e.allocationNumber, kind: 'text' },
    { field: 'invoice_number', label: 'מספר חשבונית', typed: invoice.invoice_number, ocr: e.invoiceNumber, kind: 'text' },
    { field: 'total_amount', label: 'סה"כ', typed: magnitude(invoice.total_amount), ocr: e.totalAmount, kind: 'money' },
    { field: 'vat_amount', label: 'מע"מ', typed: magnitude(invoice.vat_amount), ocr: e.vatAmount, kind: 'money' },
    { field: 'amount_before_vat', label: 'לפני מע"מ', typed: magnitude(invoice.amount_before_vat), ocr: e.amountBeforeVat, kind: 'money' },
  ];

  const rows = spec.map((s) => ({ ...s, status: compareValue(s.typed, s.ocr) }));
  const hasMismatch = rows.some((r) => r.status === 'mismatch');
  return { rows, hasMismatch };
}

function compareValue(typed, ocr) {
  const typedEmpty = typed == null || typed === '';
  const ocrEmpty = ocr == null || ocr === '';
  if (typedEmpty && ocrEmpty) return 'match';
  if (ocrEmpty) return 'missing';
  if (typedEmpty) return 'ocr_only';
  return String(typed) === String(ocr) ? 'match' : 'mismatch';
}
