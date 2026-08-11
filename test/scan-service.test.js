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
import { buildExtractionRequest, EXTRACTION_SCHEMA } from '../src/ai/claude.js';
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
      { name: 'לחם אחיד', barcode: '7290000000011', sku: 'LX1', quantity: 10, unit_cost: 50, line_total: 500, confidence: 'high' },
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
  assert.deepEqual(EXTRACTION_SCHEMA.properties.invoice_number.type, ['string', 'null']);
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
      lines: [{ name: 'לחם אחיד', barcode: '7290000000011', sku: 'LX1', quantity: 9, unitCost: toAgorot('100'), lineTotal: toAgorot('900') }],
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
  assert.equal(lines[0].barcode, '7290000000011');
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
