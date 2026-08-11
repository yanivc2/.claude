import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createDraft } from '../src/services/scan.js';

// מסכי צילום החשבוניות מקצה לקצה (HTTP), אך ללא רשת: הצילומים הם מזהים מזויפים, ולכן גם אם
// מוגדר מפתח API — טעינת הקבצים נכשלת לפני כל קריאה ל-Claude. הבדיקות מוודאות שהתבניות
// נטענות, שהתשובות של /process ו-/status.json הן JSON, ושחומת ההרשאות עובדת.

let server;
let base;
let db;
let draftId;
const cookies = {};

/** Signed session cookie header for a user row. */
function cookieFor(user) {
  return `session=${createSession(user.id)}`;
}

async function get(path, cookie) {
  return fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
}

before(async () => {
  db = await freshDb();

  const ow = await owner(db);
  cookies.owner = cookieFor(ow);

  // A "צלם חשבוניות" user: nav_scan only. A cashier: nav_zclosing only (must not reach /scan).
  const scanner = await db.run(
    "INSERT INTO users (username, name, role, permissions) VALUES ('scanner', 'צלם', 'secretary', ?)",
    [JSON.stringify(['nav_scan'])],
  );
  const cashier = await db.run(
    "INSERT INTO users (username, name, role, permissions) VALUES ('kupa', 'קופאי', 'secretary', ?)",
    [JSON.stringify(['nav_zclosing'])],
  );
  cookies.scanner = cookieFor({ id: scanner.lastInsertRowid });
  cookies.cashier = cookieFor({ id: cashier.lastInsertRowid });

  const store = await firstStore(db);
  // The scanner is scoped to the drafts' company — the permission gate, not the company
  // firewall, is what the create-supplier test exercises.
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [
    scanner.lastInsertRowid,
    store.company_id,
  ]);
  const draft = await createDraft({ storeId: store.id, imageRefs: ['fake-page-1.jpg'] }, await owner(db));
  draftId = draft.id;

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

test('GET /scan renders the capture page for an authorized user', async () => {
  const res = await get('/scan', cookies.owner);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /צילום חשבונית/);
});

test('GET /scan/pending renders the waiting list with the new draft', async () => {
  const res = await get('/scan/pending', cookies.owner);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /סריקות ממתינות/);
  assert.match(html, new RegExp(`/scan/${draftId}`));
});

test('GET /scan/:id renders the draft screen', async () => {
  const res = await get(`/scan/${draftId}`, cookies.owner);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /מחק טיוטה/); // present in the processing screen and in the review screen
});

test('POST /scan/:id/process answers JSON (never a rendered page)', async () => {
  const res = await fetch(`${base}/scan/${draftId}/process`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies.owner },
  });
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  // 503 when no API key is configured, 200 with status 'failed' when one is (the fake image
  // reference cannot be loaded, so the draft fails before any network call).
  assert.ok([200, 503].includes(res.status), `unexpected status ${res.status}`);
  const body = await res.json();
  assert.equal(typeof body.status, 'string');
});

test('GET /scan/:id/status.json is a minimal JSON poll target', async () => {
  const res = await get(`/scan/${draftId}/status.json`, cookies.owner);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(['uploaded', 'processing', 'needs_review', 'failed', 'committed'].includes(body.status));
  assert.ok('error' in body);
});

test('a failed draft renders the failure screen with a retry', async () => {
  await db.run("UPDATE invoice_drafts SET status = 'failed', error = ? WHERE id = ?", [
    'הצילומים כבדים מדי',
    draftId,
  ]);
  const res = await get(`/scan/${draftId}`, cookies.owner);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /העיבוד נכשל/);
  assert.match(html, /הצילומים כבדים מדי/);
  assert.match(html, /נסה שוב/);
});

test('a needs_review draft renders the review form, and the form saves back as edits', async () => {
  const { validateExtraction } = await import('../src/lib/extractValidate.js');
  const sup = await db.run("INSERT INTO suppliers (name, status) VALUES ('מאפייה בע\"מ', 'approved')", []);
  const suppliers = await db.many('SELECT * FROM suppliers', []);
  const normalized = validateExtraction(
    {
      supplier_name: 'מאפייה בע"מ',
      supplier_tax_id: null,
      invoice_number: 'A-1',
      allocation_number: null,
      invoice_date: '2026-07-01',
      doc_type: 'tax_invoice',
      amount_before_vat: 100,
      vat_amount: 18,
      total_amount: 118,
      lines: [{ name: 'לחם', barcode: null, sku: null, quantity: 2, unit_cost: null, line_total: 100, confidence: 'high' }],
      field_confidence: {},
      notes: null,
    },
    { suppliers, vatRate: 0.18 },
  );
  await db.run("UPDATE invoice_drafts SET status = 'needs_review', normalized = ? WHERE id = ?", [
    JSON.stringify(normalized),
    draftId,
  ]);

  const res = await get(`/scan/${draftId}`, cookies.owner);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /אשר וקלוט חשבונית/);
  assert.match(html, /name="line_name\[\]"/);
  assert.match(html, /name="amount_before_vat"/);

  const form = new URLSearchParams();
  form.set('supplier_id', String(sup.lastInsertRowid));
  form.set('invoice_number', 'A-2');
  form.set('allocation_number', '');
  form.set('invoice_date', '2026-07-02');
  form.set('doc_type', 'tax_invoice');
  form.set('amount_before_vat', '120.00');
  form.set('vat_amount', '21.60');
  form.set('total_incl', '141.60');
  form.append('line_name[]', 'לחם');
  form.append('line_barcode[]', '');
  form.append('line_sku[]', '');
  form.append('line_qty[]', '2');
  form.append('line_unit_cost[]', '');
  form.append('line_total[]', '120.00');
  form.append('line_name[]', ''); // שורה ריקה — נזרקת
  form.append('line_barcode[]', '');
  form.append('line_sku[]', '');
  form.append('line_qty[]', '');
  form.append('line_unit_cost[]', '');
  form.append('line_total[]', '');

  const saved = await fetch(`${base}/scan/${draftId}/save`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies.owner, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), `/scan/${draftId}?saved=1`);

  const row = await db.one('SELECT normalized FROM invoice_drafts WHERE id = ?', [draftId]);
  const next = JSON.parse(row.normalized);
  assert.equal(next.header.invoiceNumber, 'A-2');
  assert.equal(next.header.amountBeforeVat, 12000); // shekels → agorot at the route boundary
  assert.equal(next.header.supplierId, Number(sup.lastInsertRowid));
  assert.equal(next.lines.length, 1); // the empty row was dropped
  assert.equal(next.lines[0].lineTotal, 12000);
  assert.equal(next.lines[0].unitCost, 6000); // computed from total / quantity
  assert.equal(next.lines[0].unitCostSource, 'computed');
});

test('approving the review form creates the invoice and its lines screen renders', async () => {
  const row = await db.one('SELECT normalized FROM invoice_drafts WHERE id = ?', [draftId]);
  const h = JSON.parse(row.normalized).header;

  const form = new URLSearchParams();
  form.set('supplier_id', String(h.supplierId));
  form.set('invoice_number', h.invoiceNumber);
  form.set('allocation_number', '');
  form.set('invoice_date', h.invoiceDate);
  form.set('doc_type', 'tax_invoice');
  form.set('amount_before_vat', '120.00');
  form.set('vat_amount', '21.60');
  form.set('total_incl', '141.60');
  form.append('line_name[]', 'לחם');
  form.append('line_barcode[]', '7290000000015');
  form.append('line_sku[]', '');
  form.append('line_qty[]', '2');
  form.append('line_unit_cost[]', '60.00');
  form.append('line_total[]', '120.00');

  const res = await fetch(`${base}/scan/${draftId}/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies.owner, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.match(loc, /^\/invoices\/\d+\?scanned=1$/);

  // the invoice screen renders the read-only lines card and the scan-page thumbnails
  const page = await get(loc, cookies.owner);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /פירוט שורות/);
  assert.match(html, /עמודי הסריקה/);
  assert.match(html, /scan-image\/0/);

  // the committed draft now redirects to its invoice
  const back = await get(`/scan/${draftId}`, cookies.owner);
  assert.equal(back.status, 303);
  assert.match(back.headers.get('location'), /^\/invoices\/\d+$/);
});

test('a duplicate-warning approve comes back with the confirm block, and confirming commits', async () => {
  const { validateExtraction } = await import('../src/lib/extractValidate.js');
  const suppliers = await db.many('SELECT * FROM suppliers', []);
  const store = await firstStore(db);
  const second = await createDraft({ storeId: store.id, imageRefs: ['fake-page-2.jpg'] }, await owner(db));
  const normalized = validateExtraction(
    {
      supplier_name: 'מאפייה בע"מ',
      supplier_tax_id: null,
      invoice_number: 'A-9',
      allocation_number: null,
      invoice_date: '2026-07-05',
      doc_type: 'tax_invoice',
      amount_before_vat: 120,
      vat_amount: 21.6,
      total_amount: 141.6,
      lines: [{ name: 'לחם', barcode: null, sku: null, quantity: 1, unit_cost: 120, line_total: 120, confidence: 'high' }],
      field_confidence: {},
      notes: null,
    },
    { suppliers, vatRate: 0.18 },
  );
  await db.run("UPDATE invoice_drafts SET status = 'needs_review', normalized = ? WHERE id = ?", [
    JSON.stringify(normalized),
    second.id,
  ]);

  const form = new URLSearchParams();
  form.set('supplier_id', String(normalized.header.supplierId));
  form.set('invoice_number', 'A-9');
  form.set('allocation_number', '');
  form.set('invoice_date', '2026-07-05');
  form.set('doc_type', 'tax_invoice');
  form.set('amount_before_vat', '120.00');
  form.set('vat_amount', '21.60');
  form.set('total_incl', '141.60');
  form.append('line_name[]', 'לחם');
  form.append('line_barcode[]', '');
  form.append('line_sku[]', '');
  form.append('line_qty[]', '1');
  form.append('line_unit_cost[]', '120.00');
  form.append('line_total[]', '120.00');

  const post = (body) =>
    fetch(`${base}/scan/${second.id}/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: cookies.owner, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  // R4 (same supplier + same total inside the window) → the screen returns with the confirm block
  const warned = await post(form.toString());
  assert.equal(warned.status, 200);
  const html = await warned.text();
  assert.match(html, /אישור אזהרות/);
  assert.match(html, /name="confirm_reason"/);
  assert.match(html, /name="confirm" value="1"/);

  form.set('confirm', '1');
  form.set('confirm_reason', 'ספירה חוזרת — לא כפילות');
  const done = await post(form.toString());
  assert.equal(done.status, 303);
  assert.match(done.headers.get('location'), /^\/invoices\/\d+\?scanned=1$/);
});

test('GET /products lists the catalog the approval built, and the detail page renders', async () => {
  const res = await get('/products', cookies.owner);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /מוצרים/);
  const link = /href="\/products\/(\d+)"/.exec(html);
  assert.ok(link, 'the approved line created a catalog row');

  const detail = await get(`/products/${link[1]}`, cookies.owner);
  assert.equal(detail.status, 200);
  const dHtml = await detail.text();
  assert.match(dHtml, /היסטוריית מחירי קנייה/);
  assert.match(dHtml, /₪60\.00/); // the unit cost recorded from the approved line
});

test('a nav_scan-only user reaches /scan and is bounced away from /invoices', async () => {
  const okRes = await get('/scan', cookies.scanner);
  assert.equal(okRes.status, 200);

  const bounced = await get('/invoices', cookies.scanner);
  assert.equal(bounced.status, 302);
  assert.equal(bounced.headers.get('location'), '/scan');
});

test('a user without nav_scan cannot open /scan', async () => {
  const res = await get('/scan', cookies.cashier);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/zclosing');
});

test('an anonymous request is sent to the login page', async () => {
  const res = await get('/scan');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

/** A fresh needs_review draft with an unmatched supplier, for the create-supplier tests. */
async function unmatchedDraft() {
  const { validateExtraction } = await import('../src/lib/extractValidate.js');
  const store = await firstStore(db);
  const draft = await createDraft({ storeId: store.id, imageRefs: ['fake-page-9.jpg'] }, await owner(db));
  const suppliers = await db.many('SELECT * FROM suppliers', []);
  const normalized = validateExtraction(
    {
      supplier_name: 'טרה תעשיות חלב',
      supplier_tax_id: '520044306',
      supplier_phone: '03-9711711',
      invoice_number: 'T-77',
      allocation_number: null,
      invoice_date: '2026-08-01',
      doc_type: 'tax_invoice',
      amount_before_vat: 480,
      vat_amount: 86.4,
      total_amount: 566.4,
      lines: [{ name: 'חלב 3%', barcode: null, sku: null, quantity: 5, unit_quantity: 120, unit_cost: null, pack_cost: null, line_total: 480, confidence: 'high' }],
      field_confidence: {},
      notes: null,
    },
    { suppliers, vatRate: 0.18 },
  );
  await db.run("UPDATE invoice_drafts SET status = 'needs_review', normalized = ? WHERE id = ?", [
    JSON.stringify(normalized),
    draft.id,
  ]);
  return draft;
}

/** The full review form for that draft, as URLSearchParams (supplier deliberately empty). */
function unmatchedForm() {
  const form = new URLSearchParams();
  form.set('supplier_id', '');
  form.set('invoice_number', 'T-77');
  form.set('allocation_number', '');
  form.set('invoice_date', '2026-08-01');
  form.set('doc_type', 'tax_invoice');
  form.set('amount_before_vat', '480.00');
  form.set('vat_amount', '86.40');
  form.set('total_incl', '566.40');
  form.append('line_name[]', 'חלב 3%');
  form.append('line_barcode[]', '');
  form.append('line_sku[]', '');
  form.append('line_qty[]', '5');
  form.append('line_unit_qty[]', '120');
  form.append('line_unit_cost[]', '');
  form.append('line_total[]', '480.00');
  return form;
}

test('the review screen shows the extracted supplier details and the create panel', async () => {
  const draft = await unmatchedDraft();
  const res = await get(`/scan/${draft.id}`, cookies.owner);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /נקרא מהמסמך: טרה תעשיות חלב/);
  assert.match(html, /ח\.פ 520044306/);
  assert.match(html, /03-9711711/);
  assert.match(html, /הקם ספק חדש/);
  assert.match(html, /name="line_unit_qty\[\]"/); // the כ.בודד column is in the grid
});

test('POST /scan/:id/supplier creates a pending supplier, links it and keeps the edits', async () => {
  const draft = await unmatchedDraft();
  const form = unmatchedForm();
  form.set('sup_name', 'טרה תעשיות חלב');
  form.set('sup_tax_id', '520044306');
  form.set('sup_phone', '03-9711711');
  form.set('sup_notes', '');

  const res = await fetch(`${base}/scan/${draft.id}/supplier`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies.owner, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /supplier_created=/);

  const sup = await db.one('SELECT * FROM suppliers WHERE tax_id = ?', ['520044306']);
  assert.equal(sup.status, 'pending');
  assert.equal(sup.phone, '03-9711711');

  const row = await db.one('SELECT normalized FROM invoice_drafts WHERE id = ?', [draft.id]);
  const n = JSON.parse(row.normalized);
  assert.equal(Number(n.header.supplierId), Number(sup.id)); // linked to the draft
  assert.equal(n.lines[0].unitQuantity, 120); // the rest of the form survived the round trip
  assert.deepEqual(n.flags.supplier, []); // no more "no supplier match"
});

test('a similar supplier name requires the explicit confirm tick', async () => {
  const draft = await unmatchedDraft();
  const form = unmatchedForm();
  form.set('sup_name', 'טרה תעשיות חלב'); // now an existing supplier (created above)

  const post = (body) =>
    fetch(`${base}/scan/${draft.id}/supplier`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: cookies.owner, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  const refused = await post(form.toString());
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /דומה לספק קיים/);

  form.set('supplier_confirm', '1');
  const done = await post(form.toString());
  assert.equal(done.status, 303);
});

test('a nav_scan-only user cannot create a supplier from the scan screen', async () => {
  const draft = await unmatchedDraft();
  const form = unmatchedForm();
  form.set('sup_name', 'ספק פיראטי');

  const res = await fetch(`${base}/scan/${draft.id}/supplier`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies.scanner, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  assert.equal(res.status, 403);
  assert.ok(!(await db.one('SELECT id FROM suppliers WHERE name = ?', ['ספק פיראטי'])));
});

test('POST /scan/:id/reprocess resets the draft and redirects to the processing screen', async () => {
  const draft = await unmatchedDraft();
  const res = await fetch(`${base}/scan/${draft.id}/reprocess`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies.owner },
  });
  // With no API key the route refuses politely (400 re-render); with one it resets + redirects.
  if (res.status === 303) {
    assert.equal(res.headers.get('location'), `/scan/${draft.id}`);
    const row = await db.one('SELECT status FROM invoice_drafts WHERE id = ?', [draft.id]);
    assert.equal(row.status, 'uploaded');
  } else {
    assert.equal(res.status, 400);
    assert.match(await res.text(), /חילוץ אוטומטי אינו מוגדר/);
  }
});
