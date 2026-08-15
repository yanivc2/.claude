import Anthropic from '@anthropic-ai/sdk';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, secretary, firstStore } from './helpers.js';
import { createSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import {
  createDraft,
  processDraft,
  saveDraftEdits,
  approveDraft,
  deleteDraft,
  listPending,
  getDraft,
} from '../src/services/scan.js';
import { buildExtractionRequest, EXTRACTION_SCHEMA, SYSTEM_PROMPT } from '../src/ai/claude.js';
import { recordScan } from '../src/services/supplierProfile.js';
import { toAgorot } from '../src/lib/money.js';

// כל הבדיקות עובדות במצב לא-מקוון: לקוח Claude מזויף + loadImage מוזרק, והצילומים הם מחרוזות
// מקומיות בלבד — אין קריאה אחת לרשת או לאחסון הענן.

const SUPPLIER_NAME = 'מאפיית הבוקר בע"מ';

/** A clean, fully-readable invoice as the model would return it (decimal shekels, absolute). */
function extraction(over = {}) {
  return {
    supplier_name: SUPPLIER_NAME,
    supplier_tax_id: '514123456',
    invoice_number: '10025',
    allocation_number: '123456789',
    invoice_date: '05/07/2026',
    doc_type: 'tax_invoice',
    amount_before_vat: 1000,
    vat_amount: 180,
    total_amount: 1180,
    lines: [
      { name: 'לחם אחיד', barcode: '7290000000015', sku: 'LX1', quantity: 10, unit_cost: 50, line_total: 500, confidence: 'high' },
      { name: 'חלה', barcode: null, sku: 'CH2', quantity: 5, unit_cost: null, line_total: 500, confidence: 'medium' },
    ],
    field_confidence: {
      supplier_name: 'high',
      invoice_number: 'high',
      allocation_number: 'high',
      invoice_date: 'high',
      amount_before_vat: 'high',
      vat_amount: 'high',
      total_amount: 'high',
    },
    notes: null,
    ...over,
  };
}

/** Fake `client.messages.create` returning a canned Claude response. */
function fakeClient(payload = extraction(), over = {}) {
  return {
    calls: [],
    messages: {
      create: async function create(params) {
        client.calls.push(params);
        return {
          stop_reason: 'end_turn',
          model: 'claude-opus-5',
          usage: { input_tokens: 5000, output_tokens: 900 },
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          ...over,
        };
      },
    },
  };
}
// `client` is referenced inside fakeClient's closure above.
let client;

/** Deps for processDraft: canned response, fake page loader, controllable clock. */
function deps(payload = extraction(), over = {}) {
  client = fakeClient(payload, over);
  let clock = Date.now(); // real base so the stale-processing guard sees real timestamps
  return {
    client,
    loadImage: async () => ({ buffer: Buffer.from('x'), contentType: 'image/jpeg' }),
    now: () => (clock += 1000),
  };
}

async function setup(db) {
  const sec = await secretary(db);
  const store = await firstStore(db);
  const supplier = await createSupplier({ name: SUPPLIER_NAME, taxId: '514123456' }, sec, db);
  return { sec, store, supplier };
}

async function uploaded(db, sec, store, refs = ['page-1.jpg', 'page-2.jpg']) {
  return createDraft({ storeId: store.id, imageRefs: refs }, sec, db);
}

test('buildExtractionRequest: pages in order, PDFs as documents, cached system prompt', () => {
  const params = buildExtractionRequest([
    { buffer: Buffer.from('jpg'), contentType: 'image/jpeg' },
    { buffer: Buffer.from('pdf'), contentType: 'application/pdf' },
  ]);

  const content = params.messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.equal(content[0].source.data, Buffer.from('jpg').toString('base64'));
  assert.equal(content[1].type, 'document'); // Genius Scan PDF
  assert.equal(content[1].source.media_type, 'application/pdf');
  assert.equal(content[2].type, 'text');

  assert.equal(params.model, 'claude-opus-5');
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.output_config.format.schema, EXTRACTION_SCHEMA);
  assert.ok(params.output_config.effort);
  assert.deepEqual(params.system[0].cache_control, { type: 'ephemeral' });
  // Rejected by claude-opus-5 — they must never be sent.
  assert.equal('thinking' in params, false);
  assert.equal('temperature' in params, false);

  // Structured outputs: every object closed, every key required, nullables as type unions.
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    }
    if (node.type === 'array') walk(node.items);
  };
  walk(EXTRACTION_SCHEMA);
  // Text fields are plain strings ("" = not present) to stay under the API's 16-union limit;
  // numbers stay nullable, because 0 is a real value and a sentinel there would be dangerous.
  assert.equal(EXTRACTION_SCHEMA.properties.invoice_number.type, 'string');
  assert.deepEqual(EXTRACTION_SCHEMA.properties.total_amount.type, ['number', 'null']);
});

test('createDraft resolves the company from the store and audits the upload', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);

  const draft = await uploaded(db, sec, store);
  assert.equal(draft.status, 'uploaded');
  assert.equal(draft.store_id, store.id);
  assert.equal(draft.company_id, store.company_id);
  assert.deepEqual(draft.images, ['page-1.jpg', 'page-2.jpg']);
  assert.equal(draft.created_by, sec.id);

  const log = await db.one("SELECT * FROM audit_log WHERE action = 'scan.upload'", []);
  assert.equal(Number(log.entity_id), draft.id);
  assert.equal(JSON.parse(log.details).pages, 2);

  await assert.rejects(createDraft({ storeId: store.id, imageRefs: [] }, sec, db), /לא התקבלו צילומים/);
  await assert.rejects(createDraft({ storeId: 9999, imageRefs: ['a.jpg'] }, sec, db), /לא נמצאה/);
});

test('processDraft happy path: needs_review with extraction, normalized, tokens and duration', async () => {
  const db = await freshDb();
  const { sec, store, supplier } = await setup(db);
  const draft = await uploaded(db, sec, store);

  const done = await processDraft(draft.id, sec, deps(), db);
  assert.equal(done.status, 'needs_review');
  assert.equal(done.error, null);
  assert.equal(done.model, 'claude-opus-5');
  assert.equal(done.input_tokens, 5000);
  assert.equal(done.output_tokens, 900);
  assert.equal(done.duration_ms, 1000);
  assert.ok(done.processing_started_at);

  // The request carried both pages plus the Hebrew task text.
  assert.equal(client.calls.length, 1);
  const content = client.calls[0].messages[0].content;
  assert.equal(content.length, 3);
  assert.equal(content[0].type, 'image');
  assert.equal(content[2].type, 'text');

  assert.equal(done.extraction.invoice_number, '10025'); // raw model JSON kept verbatim
  const n = done.normalized;
  assert.equal(n.header.supplierId, supplier.id);
  assert.equal(n.header.supplierName, SUPPLIER_NAME); // as printed, not the matched row's name
  assert.equal(n.header.invoiceDate, '2026-07-05');
  assert.equal(n.header.amountBeforeVat, toAgorot('1000'));
  assert.equal(n.header.totalAmount, toAgorot('1180'));
  assert.equal(n.lines.length, 2);
  assert.equal(n.lines[1].unitCost, toAgorot('100')); // computed from 500 / 5
  assert.equal(n.lines[1].unitCostSource, 'computed');
  assert.deepEqual(n.flags.supplier, []);
  assert.equal(n.warnings.length, 0);

  const log = await db.one("SELECT * FROM audit_log WHERE action = 'scan.extract'", []);
  assert.equal(JSON.parse(log.details).inputTokens, 5000);
  assert.equal(JSON.parse(log.details).outputTokens, 900);
});

test('processDraft: a refusal fails the draft with a Hebrew message instead of throwing', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store);

  const failed = await processDraft(draft.id, sec, deps(extraction(), { stop_reason: 'refusal' }), db);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /סירבה לעבד את הצילום/);
  assert.equal(failed.normalized, null);
});

test('processDraft: max_tokens fails with the split-the-invoice message', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store);
  const failed = await processDraft(draft.id, sec, deps(extraction(), { stop_reason: 'max_tokens' }), db);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /ארוכה מדי/);
});

test('processDraft: in-flight draft is BUSY, a stale one is re-run', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store);

  const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
  await db.run("UPDATE invoice_drafts SET status = 'processing', processing_started_at = ? WHERE id = ?", [
    stamp(30 * 1000),
    draft.id,
  ]);
  await assert.rejects(processDraft(draft.id, sec, deps(), db), (err) => {
    assert.equal(err.name, 'RuleError');
    assert.equal(err.rule, 'BUSY');
    return true;
  });

  // Older than the 6-minute stale window = a crashed attempt; processing may start over.
  await db.run('UPDATE invoice_drafts SET processing_started_at = ? WHERE id = ?', [stamp(10 * 60 * 1000), draft.id]);
  const done = await processDraft(draft.id, sec, deps(), db);
  assert.equal(done.status, 'needs_review');
});

test('processDraft flags a second draft of the same invoice as dup_draft', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);

  const first = await uploaded(db, sec, store, ['a.jpg']);
  await processDraft(first.id, sec, deps(), db);

  const second = await uploaded(db, sec, store, ['b.jpg']);
  const done = await processDraft(second.id, sec, deps(), db);
  assert.ok(done.normalized.flags.invoiceNumber.includes('dup_draft'));
  assert.ok(done.normalized.warnings.some((w) => w.code === 'dup_draft' && /כבר צולמה/.test(w.message)));
});

test('processDraft flags an allocation number that already exists on an invoice', async () => {
  const db = await freshDb();
  const { sec, store, supplier } = await setup(db);
  const { invoice } = await createInvoice(
    {
      supplierId: supplier.id,
      storeId: store.id,
      invoiceNumber: 'OLD-1',
      allocationNumber: '123456789',
      invoiceDate: '2026-05-05',
      amountBeforeVat: toAgorot('50'),
      vatAmount: toAgorot('9'),
      docType: 'tax_invoice',
    },
    sec,
    db,
  );

  const draft = await uploaded(db, sec, store);
  const done = await processDraft(draft.id, sec, deps(), db);
  assert.ok(done.normalized.flags.allocationNumber.includes('dup_allocation'));
  const warn = done.normalized.warnings.find((w) => w.code === 'dup_allocation');
  assert.match(warn.message, new RegExp(`#${invoice.id}`));
  assert.match(warn.message, /ייחסם/); // the approve WILL be hard-blocked

  // ...and approving it does exactly that, leaving nothing behind.
  const before = (await db.many('SELECT id FROM invoices', [])).length;
  await assert.rejects(approveDraft(done.id, {}, sec, db), (err) => {
    assert.equal(err.name, 'RuleError');
    assert.equal(err.rule, 'R2');
    return true;
  });
  assert.equal((await db.many('SELECT id FROM invoices', [])).length, before);
  const after = await getDraft(done.id, db);
  assert.equal(after.status, 'needs_review');
  assert.equal(after.invoice_id, null);
});

test('saveDraftEdits merges edits, re-validates, and honours an explicit supplier choice', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const other = await createSupplier({ name: 'ספק אחר' }, sec, db);
  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(), db);

  const saved = await saveDraftEdits(
    draft.id,
    {
      header: { supplierId: other.id, invoiceNumber: '10026', amountBeforeVat: toAgorot('900') },
      lines: [{ name: 'לחם אחיד', barcode: '7290000000015', sku: 'LX1', quantity: 9, unitCost: toAgorot('100'), lineTotal: toAgorot('900') }],
    },
    sec,
    db,
  );

  assert.equal(saved.status, 'needs_review');
  const n = saved.normalized;
  assert.equal(n.header.supplierId, other.id); // the human's choice beats the fuzzy match
  assert.equal(n.header.supplierMethod, 'manual');
  assert.deepEqual(n.flags.supplier, []);
  assert.equal(n.header.invoiceNumber, '10026');
  assert.equal(n.header.amountBeforeVat, toAgorot('900'));
  assert.equal(n.lines.length, 1);
  assert.equal(n.lines[0].lineNo, 1);
  assert.equal(n.lines[0].unitCost, toAgorot('100'));
  assert.equal(n.lines[0].unitCostSource, 'extracted');
  // VAT was left at 180 on a 900 base — the re-validation notices.
  assert.ok(n.flags.vatAmount.includes('vat_rate_off'));

  assert.ok(await db.one("SELECT id FROM audit_log WHERE action = 'scan.edit'", []));
});

test('approveDraft creates the invoice, its lines and the supplier catalog', async () => {
  const db = await freshDb();
  const { sec, store, supplier } = await setup(db);
  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(), db);

  const { invoiceId, warnings } = await approveDraft(draft.id, {}, sec, db);
  assert.deepEqual(warnings, []);

  const invoice = await db.one('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  assert.equal(invoice.supplier_id, supplier.id);
  assert.equal(invoice.store_id, store.id);
  assert.equal(invoice.company_id, store.company_id);
  assert.equal(invoice.invoice_number, '10025');
  assert.equal(invoice.allocation_number, '123456789');
  assert.equal(invoice.invoice_date, '2026-07-05');
  assert.equal(invoice.amount_before_vat, toAgorot('1000'));
  assert.equal(invoice.vat_amount, toAgorot('180'));
  assert.equal(invoice.total_amount, toAgorot('1180'));
  assert.equal(invoice.status, 'recorded');
  assert.equal(invoice.image_path, 'page-1.jpg'); // first page is the invoice image

  const lines = await db.many('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [invoiceId]);
  assert.deepEqual(lines.map((l) => l.line_no), [1, 2]);
  assert.deepEqual(lines.map((l) => l.name), ['לחם אחיד', 'חלה']);
  assert.deepEqual(lines.map((l) => l.line_total), [toAgorot('500'), toAgorot('500')]);
  assert.equal(lines.reduce((s, l) => s + l.line_total, 0), invoice.amount_before_vat);
  assert.equal(lines[0].unit_cost, toAgorot('50'));
  assert.equal(lines[0].unit_cost_source, 'extracted');
  assert.equal(lines[1].unit_cost_source, 'computed');
  assert.equal(lines[0].barcode, '7290000000015');
  assert.equal(Number(lines[0].quantity), 10);

  const products = await db.many('SELECT * FROM products WHERE supplier_id = ? ORDER BY id', [supplier.id]);
  assert.equal(products.length, 2);
  assert.deepEqual(products.map((p) => p.last_cost), [toAgorot('50'), toAgorot('100')]);
  assert.deepEqual(products.map((p) => p.last_cost_date), ['2026-07-05', '2026-07-05']);
  assert.deepEqual(lines.map((l) => l.product_id), products.map((p) => p.id)); // lines linked

  const prices = await db.many('SELECT * FROM product_prices ORDER BY id', []);
  assert.equal(prices.length, 2);
  assert.equal(Number(prices[0].invoice_id), invoiceId);
  assert.equal(prices[0].price_date, '2026-07-05');

  const committed = await getDraft(draft.id, db);
  assert.equal(committed.status, 'committed');
  assert.equal(Number(committed.invoice_id), invoiceId);

  assert.ok(await db.one("SELECT id FROM audit_log WHERE action = 'scan.approve'", []));
  assert.ok(await db.one("SELECT id FROM audit_log WHERE action = 'invoice.create'", []));

  // Second approval is refused — the draft is no longer awaiting review.
  await assert.rejects(approveDraft(draft.id, {}, sec, db), /רק טיוטה שעברה עיבוד/);
});

test('כ.בודד flow: per-single price survives save→reload and lands in lines + catalog', async () => {
  const db = await freshDb();
  const { sec, store, supplier } = await setup(db);
  const draft = await uploaded(db, sec, store);

  // 5 cartons × 24 singles = 120; net 480 → 4.00 ₪ per single, 96.00 ₪ per carton.
  await processDraft(
    draft.id,
    sec,
    deps(
      extraction({
        amount_before_vat: 480,
        vat_amount: 86.4,
        total_amount: 566.4,
        lines: [
          { name: 'קולה 330 מ"ל', barcode: '7290000000015', sku: 'CC330', quantity: 5, unit_quantity: 120, unit_cost: null, pack_cost: null, line_total: 480, confidence: 'high' },
        ],
      }),
    ),
    db,
  );

  let d = await getDraft(draft.id, db);
  assert.equal(d.normalized.lines[0].unitQuantity, 120);
  assert.equal(d.normalized.lines[0].unitCost, toAgorot('4'));
  assert.equal(d.normalized.lines[0].packCost, toAgorot('96'));
  assert.deepEqual(d.normalized.lines[0].flags, ['computed_per_unit']);

  // The toExtraction round trip must not drop unit_quantity: a plain save keeps everything.
  await saveDraftEdits(draft.id, {}, sec, db);
  d = await getDraft(draft.id, db);
  assert.equal(d.normalized.lines[0].unitQuantity, 120);
  assert.equal(d.normalized.lines[0].unitCost, toAgorot('4'));
  assert.equal(d.normalized.lines[0].unitCostSource, 'computed');
  assert.equal(d.normalized.lines[0].packCost, toAgorot('96'));

  const { invoiceId } = await approveDraft(draft.id, {}, sec, db);
  const line = await db.one('SELECT * FROM invoice_lines WHERE invoice_id = ?', [invoiceId]);
  assert.equal(Number(line.quantity), 5);
  assert.equal(Number(line.unit_quantity), 120);
  assert.equal(line.unit_cost, toAgorot('4'));
  assert.equal(line.pack_cost, toAgorot('96'));
  assert.equal(line.line_total, toAgorot('480'));

  // The catalog tracks the per-single price, and the price row records the singles count.
  const product = await db.one('SELECT * FROM products WHERE supplier_id = ?', [supplier.id]);
  assert.equal(product.last_cost, toAgorot('4'));
  const price = await db.one('SELECT * FROM product_prices WHERE product_id = ?', [product.id]);
  assert.equal(price.price, toAgorot('4'));
  assert.equal(Number(price.quantity), 120);
});

test('processDraft attaches master-catalog info and re-derives it on every save', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const { importCatalogItems } = await import('../src/services/masterCatalog.js');
  await importCatalogItems(
    [{ barcode: '7290000000015', name: 'לחם אחיד פרוס 750 גרם', manufacturerName: 'מאפיות מאוחדות', unitQty: 'גרם', quantity: 750, qtyInPackage: null, retailPrice: 890 }],
    {},
    db,
  );

  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(), db);

  let d = await getDraft(draft.id, db);
  const line = d.normalized.lines[0];
  assert.ok(line.flags.includes('catalog_match'));
  assert.equal(line.catalog.name, 'לחם אחיד פרוס 750 גרם');
  assert.equal(line.catalog.manufacturer, 'מאפיות מאוחדות');
  assert.equal(line.catalog.nameDiffers, true); // 'לחם אחיד' vs the canonical name
  assert.equal(d.normalized.lines[1].catalog, null); // no barcode → no catalog

  // The catalog info survives (is re-derived on) a plain save.
  await saveDraftEdits(draft.id, {}, sec, db);
  d = await getDraft(draft.id, db);
  assert.ok(d.normalized.lines[0].flags.includes('catalog_match'));
  assert.equal(d.normalized.lines[0].catalog.name, 'לחם אחיד פרוס 750 גרם');
});

test('resetForReprocess sends a reviewed draft back to the queue; a committed one is refused', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(), db);
  assert.equal((await getDraft(draft.id, db)).status, 'needs_review');

  const { resetForReprocess } = await import('../src/services/scan.js');
  await resetForReprocess(draft.id, sec, db);
  const back = await getDraft(draft.id, db);
  assert.equal(back.status, 'uploaded');
  assert.ok(await db.one("SELECT id FROM audit_log WHERE action = 'scan.reprocess'", []));

  // Processing again from that state works (same photos, fresh extraction).
  await processDraft(draft.id, sec, deps(), db);
  assert.equal((await getDraft(draft.id, db)).status, 'needs_review');

  await approveDraft(draft.id, {}, sec, db);
  await assert.rejects(resetForReprocess(draft.id, sec, db), /כבר אושרה/);
});

test('approveDraft on a credit note: invoice and lines go negative, catalog prices untouched', async () => {
  const db = await freshDb();
  const { sec, store, supplier } = await setup(db);

  // A normal invoice first, so the catalog already holds a price for the same products.
  const first = await uploaded(db, sec, store, ['inv.jpg']);
  await processDraft(first.id, sec, deps(), db);
  await approveDraft(first.id, {}, sec, db);
  const pricesBefore = await db.many('SELECT * FROM product_prices ORDER BY id', []);

  const credit = await uploaded(db, sec, store, ['credit.jpg']);
  await processDraft(
    credit.id,
    sec,
    deps(extraction({ doc_type: 'credit_note', invoice_number: 'Z-77', allocation_number: null })),
    db,
  );
  const { invoiceId } = await approveDraft(credit.id, {}, sec, db);

  const invoice = await db.one('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  assert.equal(invoice.doc_type, 'credit_note');
  assert.equal(invoice.amount_before_vat, -toAgorot('1000'));
  assert.equal(invoice.total_amount, -toAgorot('1180'));

  const lines = await db.many('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [invoiceId]);
  assert.deepEqual(lines.map((l) => l.line_total), [-toAgorot('500'), -toAgorot('500')]);
  assert.equal(lines.reduce((s, l) => s + l.line_total, 0), invoice.amount_before_vat);
  assert.ok(lines.every((l) => l.unit_cost > 0)); // a unit price is never negative
  assert.ok(lines.every((l) => l.product_id)); // still linked to the catalog

  const pricesAfter = await db.many('SELECT * FROM product_prices ORDER BY id', []);
  assert.equal(pricesAfter.length, pricesBefore.length); // no price history from a return
  const products = await db.many('SELECT * FROM products ORDER BY id', []);
  assert.deepEqual(products.map((p) => p.last_cost), pricesBefore.map((p) => p.price));
  assert.equal((await db.many('SELECT id FROM products', [])).length, 2); // no duplicate catalog rows
});

test('approveDraft refuses a draft with no matched supplier', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(extraction({ supplier_name: 'ספק שאינו במערכת', supplier_tax_id: null })), db);

  const done = await getDraft(draft.id, db);
  assert.equal(done.normalized.header.supplierId, null);
  assert.ok(done.normalized.flags.supplier.includes('no_supplier_match'));

  await assert.rejects(approveDraft(draft.id, {}, sec, db), (err) => {
    assert.equal(err.name, 'RuleError');
    assert.equal(err.rule, 'VALIDATION');
    assert.match(err.message, /ספק/);
    return true;
  });
  assert.equal((await db.many('SELECT id FROM invoices', [])).length, 0);
  assert.equal((await getDraft(draft.id, db)).status, 'needs_review');
});

test('approveDraft refuses a draft that is missing required header fields', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(extraction({ invoice_number: null, total_amount: null })), db);
  await assert.rejects(approveDraft(draft.id, {}, sec, db), /חסרים שדות חובה/);
});

test('deleteDraft removes a pending draft and refuses a committed one', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);

  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(), db);
  const out = await deleteDraft(draft.id, sec, db);
  assert.equal(out.pages, 2);
  assert.equal(await db.one('SELECT id FROM invoice_drafts WHERE id = ?', [draft.id]), undefined);
  assert.ok(await db.one("SELECT id FROM audit_log WHERE action = 'scan.delete'", []));

  const kept = await uploaded(db, sec, store, ['keep.jpg']);
  await processDraft(kept.id, sec, deps(), db);
  await approveDraft(kept.id, {}, sec, db);
  await assert.rejects(deleteDraft(kept.id, sec, db), /לא ניתן למחוק/);
  assert.ok(await db.one('SELECT id FROM invoice_drafts WHERE id = ?', [kept.id]));
});

test('listPending shows drafts awaiting a human, newest first, company-scoped', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const a = await uploaded(db, sec, store, ['a.jpg']);
  const b = await uploaded(db, sec, store, ['b.jpg']);
  await processDraft(b.id, sec, deps(), db);

  const pending = await listPending(null, db);
  assert.deepEqual(pending.map((d) => d.id), [b.id, a.id]);
  assert.equal(pending[0].store_name, store.name);
  assert.equal(pending[0].created_by_name, sec.name);
  assert.equal(pending[0].normalized.header.invoiceNumber, '10025'); // JSON parsed for the list

  await approveDraft(b.id, {}, sec, db);
  assert.deepEqual((await listPending(null, db)).map((d) => d.id), [a.id]);
  assert.deepEqual(await listPending([], db), []); // a user scoped to no company sees nothing
  assert.deepEqual((await listPending([store.company_id], db)).map((d) => d.id), [a.id]);
});

test('processDraft refuses a PDF with more pages than the per-invoice cap, before calling the API', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store, ['big.pdf']);

  // A long PDF is cheap in bytes and expensive in tokens (each page also carries 1,500-3,000
  // text tokens), so the cap has to be on pages — the byte cap never catches this one.
  const pdf = Buffer.from(
    `%PDF-1.4\n${Array.from({ length: 30 }, (_, i) => `${i + 1} 0 obj\n<< /Type /Page >>\nendobj\n`).join('')}%%EOF`,
    'latin1',
  );
  const d = deps();
  d.loadImage = async () => ({ buffer: pdf, contentType: 'application/pdf' });

  const failed = await processDraft(draft.id, sec, d, db);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /30 עמודים/);
  assert.equal(d.client.calls.length, 0); // the whole point: no API call was paid for
});

test('processDraft lets a normal short PDF through', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store, ['two-pages.pdf']);
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n%%EOF',
    'latin1',
  );
  const d = deps();
  d.loadImage = async () => ({ buffer: pdf, contentType: 'application/pdf' });

  const done = await processDraft(draft.id, sec, d, db);
  assert.equal(done.status, 'needs_review');
});

test('the extract audit entry records the prompt-cache usage', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store, ['a.jpg']);
  await processDraft(draft.id, sec, deps(extraction(), {
    usage: { input_tokens: 5000, output_tokens: 900, cache_creation_input_tokens: 1200, cache_read_input_tokens: 3400 },
  }), db);

  const row = await db.one(
    "SELECT details FROM audit_log WHERE action = 'scan.extract' AND entity_id = ? ORDER BY id DESC",
    [draft.id],
  );
  const details = JSON.parse(row.details);
  assert.equal(details.cacheWriteTokens, 1200);
  assert.equal(details.cacheReadTokens, 3400);
  assert.equal(details.pages, 1);
});

test('an API failure is logged with its status and surfaced with it, not swallowed', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store, ['a.jpg']);

  const apiErr = new Anthropic.APIError(400, { type: 'error', error: { type: 'invalid_request_error' } }, 'bad request', new Headers());
  const d = deps();
  d.client = { messages: { create: async () => { throw apiErr; } } };

  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  let failed;
  try {
    failed = await processDraft(draft.id, sec, d, db);
  } finally {
    console.error = realError;
  }

  assert.equal(failed.status, 'failed');
  // The status code is the whole point: 400 / 401 / 529 need completely different responses, and
  // without it the owner and the logs see one indistinguishable "extraction failed".
  assert.match(failed.error, /\(400\)/);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[scan\] extraction failed/);
  assert.match(logged[0], /"status":400/);
  assert.match(logged[0], /invalid_request_error/);
});

test('a bad API key names the key instead of blaming the weather', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await uploaded(db, sec, store, ['a.jpg']);
  const d = deps();
  d.client = {
    messages: {
      create: async () => {
        throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error' } }, 'bad key', new Headers());
      },
    },
  };
  const realError = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await processDraft(draft.id, sec, d, db);
  } finally {
    console.error = realError;
  }
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /מפתח ה-API/);
});

test('the extraction schema stays under the API union-type limit', async () => {
  const { EXTRACTION_SCHEMA } = await import('../src/ai/claude.js');

  // The Messages API rejects a json_schema with more than 16 union-typed ("anyOf" or
  // ["x","null"]) parameters — the compilation cost is exponential. Going over it produced a
  // flat 400 in production: every scan failed, and adding one more nullable field was all it
  // took. Count them here so the next field cannot silently reintroduce it.
  let unions = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.type) || node.anyOf) unions += 1;
    for (const child of Object.values(node.properties || {})) walk(child);
    if (node.items) walk(node.items);
  };
  walk(EXTRACTION_SCHEMA);

  assert.ok(unions <= 16, `schema has ${unions} union-typed parameters, the API allows 16`);
});

test('text fields are plain strings so an empty one reads as "not present"', async () => {
  const { EXTRACTION_SCHEMA } = await import('../src/ai/claude.js');
  const { validateExtraction } = await import('../src/lib/extractValidate.js');
  const props = EXTRACTION_SCHEMA.properties;
  for (const key of ['supplier_name', 'supplier_tax_id', 'supplier_phone', 'invoice_number', 'invoice_date', 'notes']) {
    assert.equal(props[key].type, 'string', `${key} must not be nullable`);
  }
  // "" has to normalize exactly like null did, or dropping the union would change behaviour.
  const out = validateExtraction(
    {
      supplier_name: '', supplier_tax_id: '', supplier_phone: '', invoice_number: '',
      allocation_number: '', invoice_date: '', doc_type: 'tax_invoice',
      amount_before_vat: 100, vat_amount: 18, total_amount: 118,
      lines: [{ name: 'לחם', barcode: '', sku: '', quantity: 1, unit_quantity: null, unit_cost: null, pack_cost: null, line_total: 100, confidence: 'high' }],
      field_confidence: {}, notes: '',
    },
    { suppliers: [], vatRate: 0.18 },
  );
  assert.equal(out.header.supplierName, null);
  assert.equal(out.header.invoiceNumber, null);
  assert.equal(out.lines[0].barcode, null);
  assert.equal(out.lines[0].sku, null);
});

test('a scan of an invoice already on file is attached to it, not duplicated', async () => {
  // The employee photographs a delivery note for an invoice the office already keyed in. Creating
  // a second invoice would double the payable; the photo belongs ON the record that exists.
  const db = await freshDb();
  const { sec, store, supplier } = await setup(db);
  const { invoice } = await createInvoice(
    {
      supplierId: supplier.id, storeId: store.id, invoiceNumber: '10025', allocationNumber: null,
      invoiceDate: '2026-07-05', amountBeforeVat: toAgorot(1000), vatAmount: toAgorot(180),
      docType: 'tax_invoice',
    },
    sec,
    db,
  );

  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(), db);
  const after = await getDraft(draft.id, db);
  assert.equal(after.normalized.header.matchedInvoiceId, invoice.id);

  const res = await approveDraft(draft.id, {}, sec, db);
  assert.equal(res.attached, true);
  assert.equal(res.invoiceId, invoice.id);

  // One invoice, not two — and it now carries the photo and the line items it was missing.
  const invoices = await db.many('SELECT * FROM invoices WHERE supplier_id = ?', [supplier.id]);
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].image_path, 'page-1.jpg');
  const lines = await db.many('SELECT * FROM invoice_lines WHERE invoice_id = ?', [invoice.id]);
  assert.equal(lines.length, 2);
  const products = await db.many('SELECT * FROM products WHERE supplier_id = ?', [supplier.id]);
  assert.equal(products.length, 2);

  const committed = await getDraft(draft.id, db);
  assert.equal(committed.status, 'committed');
  assert.equal(committed.invoice_id, invoice.id);
});

test('attaching never rewrites the recorded amount, and never doubles existing lines', async () => {
  const db = await freshDb();
  const { sec, store, supplier } = await setup(db);
  // Recorded at a different total than the scan reads, and already carrying its own line.
  const { invoice } = await createInvoice(
    {
      supplierId: supplier.id, storeId: store.id, invoiceNumber: '10025', allocationNumber: null,
      invoiceDate: '2026-07-05', amountBeforeVat: toAgorot(900), vatAmount: toAgorot(162),
      docType: 'tax_invoice', imagePath: 'already-there.jpg',
    },
    sec,
    db,
  );
  await db.run(
    `INSERT INTO invoice_lines (invoice_id, line_no, name, quantity, unit_cost, unit_cost_source, line_total)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [invoice.id, 1, 'שורה שהוקלדה', 1, toAgorot(900), 'manual', toAgorot(900)],
  );

  const draft = await uploaded(db, sec, store);
  await processDraft(draft.id, sec, deps(), db);
  const res = await approveDraft(draft.id, {}, sec, db);

  assert.equal(res.attached, true);
  const codes = res.warnings.map((w) => w.code);
  assert.ok(codes.includes('attach_amount_differs'), 'the discrepancy is reported');
  assert.ok(codes.includes('attach_lines_exist'), 'and the existing lines are left alone');

  const row = await db.one('SELECT * FROM invoices WHERE id = ?', [invoice.id]);
  assert.equal(Number(row.total_amount), toAgorot(1062)); // the keyed-in figure stands
  assert.equal(row.image_path, 'already-there.jpg'); // an existing document is not replaced
  const lines = await db.many('SELECT * FROM invoice_lines WHERE invoice_id = ?', [invoice.id]);
  assert.equal(lines.length, 1);
});

test("the supplier's skill rides along with the very next photo", async () => {
  // End to end: a supplier that has been scanned before, a draft armed with that supplier on the
  // capture screen, and the learned layout reaching the model with the images — on the FIRST pass,
  // not on a re-run. That is the whole point of naming the supplier before shooting.
  const db = await freshDb();
  const { sec, store, supplier } = await setup(db);
  const past = {
    extraction: { invoice_number: '1', invoice_date: '01/01/2026', total_amount: 10 },
    normalized: {
      header: { invoiceNumber: '1', invoiceDate: '2026-01-01', totalAmount: 1000, allocationNumber: null },
      lines: [{ barcode: '42435', unitQuantity: 16 }, { barcode: '43890', unitQuantity: 8 }, { barcode: '4136857', unitQuantity: 12 }],
    },
  };
  // Twice: a single invoice is not evidence that this supplier ALWAYS prints a כ.בודד column, and
  // the profile deliberately waits for a second sample before saying so.
  await recordScan(supplier.id, past, 'now', db);
  await recordScan(supplier.id, past, 'now', db);

  const draft = await createDraft({ storeId: store.id, imageRefs: ['p1.jpg'], supplierId: supplier.id }, sec, db);
  assert.equal(draft.supplier_id, supplier.id);
  await processDraft(draft.id, sec, deps(), db);

  const sent = client.calls[0].messages[0].content.at(-1).text;
  assert.match(sent, /ברקוד מקוצר/, "the supplier's learned layout reached the model");
  assert.match(sent, /כ\.בודד/);
  // …and the cached system prompt is untouched, so this costs nothing extra.
  assert.equal(client.calls[0].system[0].text, SYSTEM_PROMPT);
});

test('a supplier never scanned before adds nothing to the request', async () => {
  const db = await freshDb();
  const { sec, store } = await setup(db);
  const draft = await createDraft({ storeId: store.id, imageRefs: ['p1.jpg'] }, sec, db);
  await processDraft(draft.id, sec, deps(), db);
  const sent = client.calls[0].messages[0].content.at(-1).text;
  assert.ok(!/מסריקות קודמות/.test(sent), 'no profile section at all');
});
