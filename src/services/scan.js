import Anthropic from '@anthropic-ai/sdk';
import { getExecutor, nowTs, tx } from '../db/adapter.js';
import { config } from '../config.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeClause } from '../lib/scope.js';
import { del, getObject } from '../lib/storage.js';
import { validateExtraction } from '../lib/extractValidate.js';
import { looksLikePdf, pdfPageCount } from '../lib/pdfPages.js';
import { buildExtractionRequest, getClaudeClient } from '../ai/claude.js';
import { createInvoice } from './invoices.js';
import { upsertProductsFromLines } from './products.js';
import { lookupByBarcodes } from './masterCatalog.js';
import { logAction } from './audit.js';

// צילום חשבוניות (stage 5) — the draft pipeline behind the mobile capture screen:
//   upload → process (Claude) → needs_review → approve → invoice + lines + catalog.
// A draft is a staging area, never money: nothing is written to `invoices` until a human
// approves. Everything the model produces is normalized by src/lib/extractValidate.js (pure)
// and stored as JSON on the draft row; this service owns the DB, the API call and the commit.

/** A 'processing' draft older than this is a crashed attempt — reprocessing is allowed. */
const STALE_PROCESSING_MS = 6 * 60 * 1000;
/** Total bytes of all pages we are willing to send in one request. */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Statuses shown in the "ממתינות לאישור" list. */
const PENDING_STATUSES = ['uploaded', 'processing', 'needs_review', 'failed'];

/**
 * Master-catalog rows for the barcodes present in a set of lines — a small Map handed to the
 * pure validator (which never queries the DB itself).
 */
function masterCatalogFor(barcodes, x) {
  return lookupByBarcodes(barcodes, x);
}

/**
 * Extra flag codes this service adds to the pure validator's flags (duplicate probes need the
 * DB, so they cannot live in extractValidate.js):
 *   'dup_allocation' — the allocation number already exists on an invoice (hard block at approve)
 *   'dup_number'     — same supplier + invoice number already exists (soft warning)
 *   'dup_draft'      — another pending draft looks like the same document
 */

/** Portable 'YYYY-MM-DD HH:MM:SS' UTC timestamp from epoch millis (mirrors adapter.nowTs). */
function tsOf(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Epoch millis of a stored 'YYYY-MM-DD HH:MM:SS' UTC timestamp, or null. */
function msOf(ts) {
  if (!ts) return null;
  const parsed = Date.parse(`${String(ts).replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** JSON.parse that never throws — a corrupt column must not break the review screen. */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Raw draft row (no JSON parsing), or undefined. */
function rawDraft(id, x) {
  return x.one('SELECT * FROM invoice_drafts WHERE id = ?', [id]);
}

/** Draft row with its JSON columns parsed. */
function shape(row) {
  return {
    ...row,
    images: parseJson(row.images) || [],
    extraction: parseJson(row.extraction),
    normalized: parseJson(row.normalized),
  };
}

/**
 * One draft, with `images` / `extraction` / `normalized` parsed from their JSON columns.
 * @param {number} id
 * @param {import('../db/adapter.js').Executor} [x]
 */
export async function getDraft(id, x = getExecutor()) {
  const row = await rawDraft(id, x);
  if (!row) throw new NotFoundError(`טיוטת סריקה ${id} לא נמצאה`);
  return shape(row);
}

/**
 * Register an uploaded set of photos as a new draft. The company is resolved from the store,
 * so the draft is scoped exactly like the invoice it will become.
 *
 * @param {{storeId: number, imageRefs: string[]}} input storage refs IN PAGE ORDER
 * @returns {Promise<object>} the new draft (parsed)
 */
export async function createDraft({ storeId, imageRefs }, actor, x = getExecutor()) {
  const refs = Array.isArray(imageRefs) ? imageRefs.filter(Boolean) : [];
  if (refs.length === 0) throw new RuleError('VALIDATION', 'לא התקבלו צילומים');
  const store = await x.one('SELECT id, company_id FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);

  const info = await x.run(
    `INSERT INTO invoice_drafts (store_id, company_id, status, images, created_by)
     VALUES (?, ?, 'uploaded', ?, ?)`,
    [storeId, store.company_id, JSON.stringify(refs), actor?.id ?? null],
  );
  await logAction(
    {
      userId: actor?.id ?? null,
      action: 'scan.upload',
      entityType: 'invoice_draft',
      entityId: info.lastInsertRowid,
      details: { storeId, pages: refs.length },
    },
    x,
  );
  return getDraft(info.lastInsertRowid, x);
}

/** Mark a draft failed with a friendly Hebrew message and return it (never throws on its own). */
async function markFailed(id, message, x) {
  await x.run("UPDATE invoice_drafts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [
    message,
    nowTs(),
    id,
  ]);
  return getDraft(id, x);
}

/**
 * Friendly Hebrew text for a thrown Anthropic SDK error; returns null for anything that isn't one
 * (the caller then treats it as a bug and rethrows).
 *
 * The generic branch carries the HTTP status, because without it "שירות החילוץ החזיר שגיאה" is
 * undiagnosable from the outside: 401 (bad key), 400 (bad request, or an exhausted credit
 * balance) and 529 (overloaded) all look identical to the owner and to the logs, and they need
 * completely different responses.
 */
function apiErrorMessage(err) {
  if (err instanceof Anthropic.RateLimitError) return 'העומס גבוה — נסו שוב בעוד רגע';
  if (err instanceof Anthropic.APIConnectionError) {
    return 'אין תקשורת עם שירות החילוץ — בדקו את חיבור האינטרנט ונסו שוב';
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return 'מפתח ה-API של שירות החילוץ אינו תקין או פג — יש לעדכן אותו בהגדרות הפרויקט';
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ? ` (${err.status})` : '';
    return `שירות החילוץ החזיר שגיאה${status} — נסו שוב בעוד מספר דקות`;
  }
  return null;
}

/**
 * Put the real API failure in the server log. The draft only ever stores the friendly Hebrew text,
 * so without this an extraction failure leaves no trace anywhere and can only be guessed at.
 */
function logApiError(id, err) {
  const detail = {
    draft: id,
    name: err?.constructor?.name ?? typeof err,
    status: err?.status ?? null,
    type: err?.error?.type ?? err?.error?.error?.type ?? null,
    message: err?.message ?? String(err),
  };
  console.error('[scan] extraction failed', JSON.stringify(detail));
}

/**
 * Run the extraction for a draft: send every page to Claude in one request, normalize the
 * answer, probe for duplicates, and park the result on the draft for review.
 *
 * Failure is a state, not an exception: a refusal, an over-long invoice, an API error or images
 * that are too heavy all end with `status='failed'`, a Hebrew `error` and the draft RETURNED, so
 * the capture screen can offer "נסה שוב". Only status/DB problems throw.
 *
 * Idempotency: a draft that is already `processing` and younger than 6 minutes throws
 * RuleError('BUSY') (the route maps it to 409); an older one is treated as a crashed attempt.
 *
 * @param {number} id
 * @param {object} actor
 * @param {{client?: object, loadImage?: Function, now?: Function}} [deps] injected in tests
 * @param {import('../db/adapter.js').Executor} [x]
 * @returns {Promise<object>} the draft (needs_review on success, failed otherwise)
 */
export async function processDraft(
  id,
  actor,
  { client = null, loadImage = getObject, now = () => Date.now() } = {},
  x = getExecutor(),
) {
  const draft = await rawDraft(id, x);
  if (!draft) throw new NotFoundError(`טיוטת סריקה ${id} לא נמצאה`);
  if (draft.status === 'committed') {
    throw new RuleError('STATE', 'הטיוטה כבר אושרה והפכה לחשבונית — לא ניתן לעבד מחדש');
  }
  if (draft.status === 'processing') {
    const previousStartMs = msOf(draft.processing_started_at);
    if (previousStartMs !== null && now() - previousStartMs < STALE_PROCESSING_MS) {
      throw new RuleError('BUSY', 'הצילום כבר בעיבוד — המתינו לסיום');
    }
    // Older than the stale window: the previous attempt died (serverless timeout) — re-run.
  }

  const startedMs = now();
  await x.run(
    "UPDATE invoice_drafts SET status = 'processing', processing_started_at = ?, error = NULL, updated_at = ? WHERE id = ?",
    [tsOf(startedMs), nowTs(), id],
  );

  // ---- load the pages ---------------------------------------------------------
  const refs = parseJson(draft.images) || [];
  const pages = [];
  let bytes = 0;
  try {
    for (const ref of refs) {
      const page = await loadImage(ref);
      bytes += page?.buffer?.length ?? 0;
      pages.push(page);
    }
  } catch {
    // A missing/unreadable blob is a dead end for this draft — offer a re-upload, not a 500.
    return markFailed(id, 'לא ניתן לקרוא את הצילומים שנשמרו — צלמו והעלו שוב', x);
  }
  if (pages.length === 0) return markFailed(id, 'לא נמצאו צילומים לטיוטה — צלמו שוב', x);
  if (bytes > MAX_TOTAL_BYTES) {
    return markFailed(id, 'הצילומים כבדים מדי (מעל 20 מ"ב) — צלמו שוב או העלו פחות עמודים', x);
  }
  // A PDF costs image tokens PLUS 1,500–3,000 text tokens per page, so a long PDF is expensive
  // long before it is heavy: 300 pages fit comfortably inside the byte cap. Refuse it here, before
  // the API call, rather than paying for it. An unreadable page count (null) is let through — the
  // byte cap and the model's own max_tokens guard remain.
  const pdfPages = pages.reduce((sum, p) => sum + (looksLikePdf(p?.buffer) ? pdfPageCount(p.buffer) || 0 : 0), 0);
  if (pdfPages > config.ai.maxScanImages) {
    return markFailed(
      id,
      `הקובץ מכיל ${pdfPages} עמודים — עד ${config.ai.maxScanImages} עמודים לחשבונית. פצלו את הקובץ והעלו שוב`,
      x,
    );
  }

  // ---- call the model ---------------------------------------------------------
  const api = client || getClaudeClient();
  let response;
  try {
    response = await api.messages.create(buildExtractionRequest(pages));
  } catch (err) {
    logApiError(id, err);
    const message = apiErrorMessage(err);
    // Anthropic errors are expected weather — anything else is a bug: record it, then rethrow.
    if (message) return markFailed(id, message, x);
    await markFailed(id, 'שגיאה בלתי צפויה בעיבוד הצילום', x);
    throw err;
  }
  const durationMs = now() - startedMs;

  if (response.stop_reason === 'refusal') {
    return markFailed(id, 'המערכת סירבה לעבד את הצילום — נסו לצלם שוב באור טוב יותר', x);
  }
  if (response.stop_reason === 'max_tokens') {
    return markFailed(id, 'החשבונית ארוכה מדי לעיבוד אחד — פצלו את הצילום לשתי חשבוניות', x);
  }

  const textBlock = (response.content || []).find((b) => b && b.type === 'text');
  const parsed = textBlock ? parseJson(textBlock.text) : null;
  if (!parsed) return markFailed(id, 'תשובת החילוץ לא הייתה תקינה — נסו שוב', x);

  // ---- normalize + duplicate probes -------------------------------------------
  const suppliers = await x.many('SELECT * FROM suppliers', []);
  const masterCatalog = await masterCatalogFor((parsed.lines || []).map((l) => l?.barcode), x);
  const normalized = validateExtraction(parsed, { suppliers, vatRate: config.vatRate, masterCatalog });
  await probeDuplicates(id, normalized, x);

  await x.run(
    `UPDATE invoice_drafts
        SET status = 'needs_review', extraction = ?, normalized = ?, model = ?,
            input_tokens = ?, output_tokens = ?, duration_ms = ?, error = NULL, updated_at = ?
      WHERE id = ?`,
    [
      JSON.stringify(parsed),
      JSON.stringify(normalized),
      response.model ?? null,
      response.usage?.input_tokens ?? null,
      response.usage?.output_tokens ?? null,
      durationMs,
      nowTs(),
      id,
    ],
  );
  await logAction(
    {
      userId: actor?.id ?? null,
      action: 'scan.extract',
      entityType: 'invoice_draft',
      entityId: id,
      details: {
        model: response.model ?? null,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        // The system prompt is sent with cache_control: ephemeral. These two make the saving
        // visible per draft without a schema change — a healthy run reads the prompt from cache
        // (cacheReadTokens > 0) instead of paying to write it again.
        cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? null,
        cacheReadTokens: response.usage?.cache_read_input_tokens ?? null,
        pages: pages.length,
        durationMs,
        lines: normalized.lines.length,
      },
    },
    x,
  );
  return getDraft(id, x);
}

/**
 * Merge DB-only duplicate findings INTO the normalized draft (flags + Hebrew warnings).
 * Mutates `normalized` in place — it is about to be persisted.
 */
async function probeDuplicates(id, normalized, x) {
  const { header, flags, warnings } = normalized;
  const addFlag = (field, code) => {
    if (flags[field] && !flags[field].includes(code)) flags[field].push(code);
  };

  if (header.allocationNumber) {
    const clash = await x.one('SELECT id FROM invoices WHERE allocation_number = ?', [header.allocationNumber]);
    if (clash) {
      addFlag('allocationNumber', 'dup_allocation');
      warnings.push({
        code: 'dup_allocation',
        message:
          `מספר הקצאה ${header.allocationNumber} כבר קיים בחשבונית #${clash.id} — ` +
          'אישור הטיוטה ייחסם עד לתיקון המספר (כפילות חסומה).',
      });
    }
  }

  if (header.supplierId && header.invoiceNumber) {
    const clash = await x.one('SELECT id FROM invoices WHERE supplier_id = ? AND invoice_number = ?', [
      header.supplierId,
      header.invoiceNumber,
    ]);
    if (clash) {
      addFlag('invoiceNumber', 'dup_number');
      warnings.push({
        code: 'dup_number',
        message: `כבר קיימת חשבונית #${clash.id} לספק זה עם מספר ${header.invoiceNumber} — ודאו שאינה כפילות.`,
      });
    }
  }

  // Another pending draft of the same document (double capture by two employees / two phones).
  const others = await x.many(
    `SELECT id, normalized FROM invoice_drafts
      WHERE id <> ? AND normalized IS NOT NULL AND status NOT IN ('committed', 'failed')`,
    [id],
  );
  for (const other of others) {
    const otherHeader = parseJson(other.normalized)?.header;
    if (!otherHeader) continue;
    const sameNumber =
      header.supplierId &&
      header.invoiceNumber &&
      otherHeader.supplierId === header.supplierId &&
      otherHeader.invoiceNumber === header.invoiceNumber;
    const sameAllocation =
      header.allocationNumber && otherHeader.allocationNumber === header.allocationNumber;
    if (sameNumber || sameAllocation) {
      addFlag('invoiceNumber', 'dup_draft');
      warnings.push({
        code: 'dup_draft',
        message: `ייתכן שחשבונית זו כבר צולמה — קיימת טיוטה פתוחה #${other.id}.`,
      });
      break;
    }
  }
}

// ---- edits -------------------------------------------------------------------

/** extraction key ↔ flag field ↔ header field, for carrying the model's confidence over an edit. */
const CONFIDENCE_MAP = [
  ['supplier_name', 'supplier', 'supplierName'],
  ['supplier_phone', 'supplier', 'supplierPhone'],
  ['invoice_number', 'invoiceNumber', 'invoiceNumber'],
  ['allocation_number', 'allocationNumber', 'allocationNumber'],
  ['invoice_date', 'invoiceDate', 'invoiceDate'],
  ['amount_before_vat', 'amountBeforeVat', 'amountBeforeVat'],
  ['vat_amount', 'vatAmount', 'vatAmount'],
  ['total_amount', 'totalAmount', 'totalAmount'],
];

/** Integer agorot back to the decimal shekels the extraction shape uses. */
function toShekels(agorot) {
  return agorot === null || agorot === undefined ? null : agorot / 100;
}

/** True when this line's unit cost was derived by the server and can be derived again. */
function derivable(line) {
  if (line.unitCostSource !== 'computed' || line.lineTotal === null) return false;
  return line.unitQuantity > 0 || line.quantity > 0;
}

/**
 * Rebuild an extraction-shaped object from a (possibly edited) normalized draft, so the SAME
 * pure validator re-derives computed unit costs, VAT math and Σ-lines checks after an edit —
 * no second implementation of those rules. Confidence the model reported is carried over for
 * header fields the human did not touch.
 */
function toExtraction(normalized, previous) {
  const h = normalized.header;
  const fieldConfidence = {};
  for (const [key, flagField, headerField] of CONFIDENCE_MAP) {
    const wasLow = (previous?.flags?.[flagField] || []).includes('low_confidence');
    const untouched = !previous?.header || previous.header[headerField] === h[headerField];
    fieldConfidence[key] = wasLow && untouched ? 'low' : 'medium';
  }
  return {
    supplier_name: h.supplierName,
    supplier_tax_id: h.supplierTaxId,
    supplier_phone: h.supplierPhone ?? null,
    invoice_number: h.invoiceNumber,
    allocation_number: h.allocationNumber,
    invoice_date: h.invoiceDate,
    doc_type: h.docType,
    amount_before_vat: toShekels(h.amountBeforeVat),
    vat_amount: toShekels(h.vatAmount),
    total_amount: toShekels(h.totalAmount),
    lines: (normalized.lines || []).map((l) => ({
      name: l.name,
      barcode: l.barcode,
      sku: l.sku,
      quantity: l.quantity,
      unit_quantity: l.unitQuantity ?? null,
      // A cost the server derived (line total / singles-or-quantity) is handed back as null so
      // the validator derives it again and the line keeps its computed badge; a printed or
      // hand-typed cost is passed through and stays 'extracted'.
      unit_cost: derivable(l) ? null : toShekels(l.unitCost),
      pack_cost: toShekels(l.packCost),
      line_total: toShekels(l.lineTotal),
      confidence: l.confidence || 'medium',
    })),
    field_confidence: fieldConfidence,
    notes: normalized.notes ?? null,
  };
}

/**
 * Apply the review-screen edits to a stored draft and re-validate the result.
 * `edits.header` is a partial header patch (money already in agorot); `edits.lines`, when
 * present, REPLACES the line list wholesale (rows the user deleted are simply absent).
 * An explicitly chosen `edits.header.supplierId` beats the fuzzy match and clears its flags.
 *
 * @returns {Promise<object>} the re-validated normalized draft
 */
async function applyEdits(previous, edits = {}, x = getExecutor()) {
  const merged = {
    ...previous,
    header: { ...previous.header, ...(edits.header || {}) },
    lines: Array.isArray(edits.lines) ? edits.lines : previous.lines,
  };
  const suppliers = await x.many('SELECT * FROM suppliers', []);
  // Catalog info is re-derived on every pass (never round-tripped through toExtraction),
  // so an edited barcode gets a fresh verdict.
  const masterCatalog = await masterCatalogFor((merged.lines || []).map((l) => l?.barcode), x);
  const next = validateExtraction(toExtraction(merged, previous), {
    suppliers,
    vatRate: config.vatRate,
    masterCatalog,
  });

  const chosen = edits.header?.supplierId;
  if (chosen) {
    // The human picked a supplier from the list — that beats any name similarity score.
    next.header.supplierId = chosen;
    next.header.supplierScore = 1;
    next.header.supplierMethod = 'manual';
    next.flags.supplier = next.flags.supplier.filter(
      (c) => c !== 'no_supplier_match' && c !== 'fuzzy_match',
    );
    next.warnings = next.warnings.filter(
      (w) => w.code !== 'no_supplier_match' && w.code !== 'fuzzy_match',
    );
  }
  return next;
}

/**
 * Save the review-screen edits without approving (the "שמור טיוטה" button).
 * @param {number} id
 * @param {{header?: object, lines?: object[]}} edits already parsed by the route
 */
export async function saveDraftEdits(id, edits, actor, x = getExecutor()) {
  const draft = await getDraft(id, x);
  if (draft.status === 'committed') throw new RuleError('STATE', 'הטיוטה כבר אושרה — לא ניתן לערוך');
  if (!draft.normalized) throw new RuleError('STATE', 'הטיוטה עדיין לא עובדה — אין מה לערוך');

  const normalized = await applyEdits(draft.normalized, edits, x);
  await x.run('UPDATE invoice_drafts SET normalized = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(normalized),
    nowTs(),
    id,
  ]);
  await logAction(
    {
      userId: actor?.id ?? null,
      action: 'scan.edit',
      entityType: 'invoice_draft',
      entityId: id,
      details: {
        supplierId: normalized.header.supplierId,
        lines: normalized.lines.length,
      },
    },
    x,
  );
  return getDraft(id, x);
}

/**
 * Send a draft back to the extraction queue (the "עבד מחדש" button) — e.g. after the
 * extraction logic improved. The stored photos are reused; edits made so far are discarded
 * because processDraft overwrites `normalized` with a fresh extraction.
 */
export async function resetForReprocess(id, actor, x = getExecutor()) {
  const draft = await getDraft(id, x);
  if (draft.status === 'committed') {
    throw new RuleError('STATE', 'הטיוטה כבר אושרה והפכה לחשבונית — לא ניתן לעבד מחדש');
  }
  await x.run(
    "UPDATE invoice_drafts SET status = 'uploaded', error = NULL, updated_at = ? WHERE id = ?",
    [nowTs(), id],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'scan.reprocess', entityType: 'invoice_draft', entityId: id },
    x,
  );
  return getDraft(id, x);
}

// ---- approval ----------------------------------------------------------------

/** Fields without which a draft cannot become an invoice. */
function assertApprovable(header, storeId) {
  const missing = [];
  if (!header.supplierId) missing.push('ספק');
  if (!storeId) missing.push('חנות');
  if (!header.invoiceNumber) missing.push('מספר חשבונית');
  if (!header.invoiceDate) missing.push('תאריך חשבונית');
  if (header.amountBeforeVat === null || header.amountBeforeVat === undefined) missing.push('סכום לפני מע"מ');
  if (header.totalAmount === null || header.totalAmount === undefined) missing.push('סה"כ לתשלום');
  if (missing.length) {
    throw new RuleError('VALIDATION', `לא ניתן לאשר — חסרים שדות חובה: ${missing.join(', ')}`);
  }
}

/**
 * Approve a reviewed draft: create the invoice (all entry-time control rules apply), store its
 * line items, fold them into the supplier's catalog, and mark the draft committed.
 *
 * Everything happens in one transaction, so a rule violation (R2 duplicate allocation) leaves
 * the draft exactly as it was — the route re-renders the review screen with the warnings.
 * RuleError from createInvoice propagates untouched (WARN carries `needsConfirmation`, and the
 * form resubmits with `confirm`).
 *
 * @param {number} id
 * @param {{edits?: object, confirm?: boolean, confirmReason?: string|null}} input
 * @returns {Promise<{invoiceId: number, warnings: Array<{code:string,message:string}>}>}
 */
export async function approveDraft(
  id,
  { edits = {}, confirm = false, confirmReason = null } = {},
  actor,
  x = getExecutor(),
) {
  const draft = await getDraft(id, x);
  if (draft.status !== 'needs_review') {
    throw new RuleError('STATE', 'ניתן לאשר רק טיוטה שעברה עיבוד וממתינה לבדיקה');
  }
  const normalized = await applyEdits(draft.normalized || {}, edits, x);
  const header = normalized.header;
  assertApprovable(header, draft.store_id);

  const isCredit = header.docType === 'credit_note';
  // createInvoice stores credit notes negative (src/services/invoices.js: sign = -1 applied to
  // amount_before_vat / vat_amount / total_amount). Mirror that on the lines so Σ line_total
  // matches the invoice's amount_before_vat sign. Only line_total flips: unit_cost is a price
  // per unit and stays positive, exactly as the schema comment on invoice_lines describes.
  const lineSign = isCredit ? -1 : 1;

  return tx(async (t) => {
    const { invoice, warnings } = await createInvoice(
      {
        supplierId: header.supplierId,
        storeId: draft.store_id,
        invoiceNumber: header.invoiceNumber,
        allocationNumber: header.allocationNumber,
        invoiceDate: header.invoiceDate,
        amountBeforeVat: header.amountBeforeVat,
        vatAmount: header.vatAmount ?? header.totalAmount - header.amountBeforeVat,
        docType: header.docType,
        imagePath: draft.images[0] ?? null,
        confirm,
        confirmReason,
      },
      actor,
      t,
    );

    // Catalog first: the products map gives each line its product_id.
    // Credit notes link to the catalog but do NOT write price history — a return is not a
    // purchase price, and letting it set last_cost would corrupt the trend.
    const byLine = await upsertProductsFromLines(
      header.supplierId,
      invoice.id,
      header.invoiceDate,
      normalized.lines,
      { recordPrices: !isCredit },
      t,
    );

    for (const line of normalized.lines) {
      await t.run(
        `INSERT INTO invoice_lines
           (invoice_id, product_id, line_no, name, barcode, sku, quantity, unit_quantity,
            unit_cost, unit_cost_source, pack_cost, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoice.id,
          byLine.get(line.lineNo) ?? null,
          line.lineNo,
          line.name ?? '',
          line.barcode ?? null,
          line.sku ?? null,
          line.quantity ?? 1,
          line.unitQuantity ?? null,
          line.unitCost === null || line.unitCost === undefined ? null : Math.abs(line.unitCost),
          line.unitCostSource,
          // A price (per single or per carton) is never negative — only line_total carries the
          // credit-note sign.
          line.packCost === null || line.packCost === undefined ? null : Math.abs(line.packCost),
          lineSign * Math.abs(line.lineTotal ?? 0),
        ],
      );
    }

    await t.run(
      "UPDATE invoice_drafts SET status = 'committed', invoice_id = ?, normalized = ?, error = NULL, updated_at = ? WHERE id = ?",
      [invoice.id, JSON.stringify(normalized), nowTs(), id],
    );
    await logAction(
      {
        userId: actor?.id ?? null,
        action: 'scan.approve',
        entityType: 'invoice_draft',
        entityId: id,
        details: {
          invoiceId: invoice.id,
          docType: header.docType,
          lines: normalized.lines.length,
          dismissedWarnings: warnings.map((w) => w.code),
        },
      },
      t,
    );
    return { invoiceId: invoice.id, warnings };
  });
}

/**
 * Discard a draft and its photos. A committed draft is the audit trail of an existing invoice
 * and can never be deleted; the blobs go away best-effort after the row.
 */
export async function deleteDraft(id, actor, x = getExecutor()) {
  const draft = await getDraft(id, x);
  if (draft.status === 'committed') {
    throw new RuleError('STATE', 'הטיוטה כבר אושרה והפכה לחשבונית — לא ניתן למחוק');
  }
  await x.run('DELETE FROM invoice_drafts WHERE id = ?', [id]);
  for (const ref of draft.images) {
    try {
      await del(ref);
    } catch {
      /* ניקוי קבצים הוא מאמץ מיטבי — הטיוטה כבר נמחקה */
    }
  }
  await logAction(
    {
      userId: actor?.id ?? null,
      action: 'scan.delete',
      entityType: 'invoice_draft',
      entityId: id,
      details: { status: draft.status, pages: draft.images.length },
    },
    x,
  );
  return { deleted: true, pages: draft.images.length };
}

/**
 * Drafts still waiting for a human ("ממתינות לאישור"), newest first, company-scoped.
 * @param {number[]|null} scope authorized company ids, null = all (owner)
 */
export async function listPending(scope = null, x = getExecutor()) {
  const sc = scopeClause(scope, 'd.company_id');
  const placeholders = PENDING_STATUSES.map(() => '?').join(', ');
  const rows = await x.many(
    `SELECT d.*, st.name AS store_name, u.name AS created_by_name
       FROM invoice_drafts d
       JOIN stores st ON st.id = d.store_id
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.status IN (${placeholders})${sc.sql}
      ORDER BY d.id DESC`,
    [...PENDING_STATUSES, ...sc.params],
  );
  return rows.map(shape); // the list renders the supplier/total straight off `normalized`
}
