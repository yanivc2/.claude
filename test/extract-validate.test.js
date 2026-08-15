import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateExtraction,
  toAgorotFromNumber,
  parseDateILS,
  FLAG_CODES,
  FLAG_FIELDS,
} from '../src/lib/extractValidate.js';

const SUPPLIERS = [
  { id: 7, name: 'מאפיית הבוקר בע"מ', tax_id: '514111222' },
  { id: 8, name: 'חשמל ותאורה דרום בע"מ', tax_id: '515999888' },
];
const OPTS = { suppliers: SUPPLIERS, vatRate: 0.18 };

/** A clean tax invoice: exact supplier by tax id, 1000 + 180 = 1180, no lines. */
function extraction(over = {}) {
  return {
    supplier_name: 'מאפיית הבוקר בע"מ',
    supplier_tax_id: '514111222',
    invoice_number: '10025',
    allocation_number: null,
    invoice_date: '2026-07-05',
    doc_type: 'tax_invoice',
    amount_before_vat: 1000,
    vat_amount: 180,
    total_amount: 1180,
    lines: [],
    field_confidence: {},
    notes: null,
    ...over,
  };
}

const codes = (warnings) => warnings.map((w) => w.code);

test('toAgorotFromNumber converts numbers, numeric strings and nulls', () => {
  assert.equal(toAgorotFromNumber(12.34), 1234);
  assert.equal(toAgorotFromNumber(1234), 123400);
  assert.equal(toAgorotFromNumber('1,234.56'), 123456);
  assert.equal(toAgorotFromNumber('₪ 90.5'), 9050);
  assert.equal(toAgorotFromNumber(19.99), 1999); // no binary-float drift
  assert.equal(toAgorotFromNumber(0), 0);
  assert.equal(toAgorotFromNumber(null), null);
  assert.equal(toAgorotFromNumber(undefined), null);
  assert.equal(toAgorotFromNumber('abc'), null);
  assert.equal(toAgorotFromNumber(''), null);
});

test('a clean invoice produces no flags and no warnings', () => {
  const d = validateExtraction(extraction(), OPTS);
  assert.deepEqual(Object.keys(d.flags).sort(), [...FLAG_FIELDS].sort());
  for (const f of FLAG_FIELDS) assert.deepEqual(d.flags[f], [], `flag ${f}`);
  assert.deepEqual(d.warnings, []);
  assert.equal(d.header.supplierId, 7);
  assert.equal(d.header.supplierMethod, 'tax_id');
  assert.equal(d.header.supplierScore, 1);
  assert.equal(d.header.supplierName, 'מאפיית הבוקר בע"מ'); // as printed on the document
  assert.equal(d.header.amountBeforeVat, 100000);
  assert.equal(d.header.vatAmount, 18000);
  assert.equal(d.header.totalAmount, 118000);
  assert.equal(d.header.docType, 'tax_invoice');
  assert.equal(d.header.allocationNumber, null);
  assert.deepEqual(d.lines, []);
  assert.equal(d.notes, null);
});

test('header money accepts numeric strings from the model', () => {
  const d = validateExtraction(
    extraction({ amount_before_vat: '1,234.56', vat_amount: '222.22', total_amount: '1,456.78' }),
    OPTS,
  );
  assert.equal(d.header.amountBeforeVat, 123456);
  assert.equal(d.header.vatAmount, 22222);
  assert.equal(d.header.totalAmount, 145678);
  assert.deepEqual(d.flags.amountBeforeVat, []);
});

test('unit cost is computed from the line total when not printed (with rounding)', () => {
  const d = validateExtraction(
    extraction({
      amount_before_vat: 100,
      vat_amount: 18,
      total_amount: 118,
      lines: [{ name: 'לחם אחיד', barcode: '7290001234563', sku: 'A-1', quantity: 3, unit_cost: null, line_total: 100, confidence: 'high' }],
    }),
    OPTS,
  );
  const line = d.lines[0];
  assert.equal(line.lineNo, 1);
  assert.equal(line.name, 'לחם אחיד');
  assert.equal(line.barcode, '7290001234563');
  assert.equal(line.sku, 'A-1');
  assert.equal(line.lineTotal, 10000);
  assert.equal(line.unitCost, 3333); // 10000 / 3 rounded
  assert.equal(line.unitCostSource, 'computed');
  assert.deepEqual(line.flags, ['computed']);
  assert.deepEqual(d.flags.linesSum, []);
});

test('unit_quantity (כ.בודד) becomes the division basis for the per-single price', () => {
  // 5 cartons × 24 singles; net total 480 → per single 4.00 ₪, per carton 96.00 ₪.
  const d = validateExtraction(
    extraction({
      amount_before_vat: 480,
      vat_amount: 86.4,
      total_amount: 566.4,
      lines: [{ name: 'קולה 330 מ"ל', barcode: '7290000000015', sku: null, quantity: 5, unit_quantity: 120, unit_cost: null, pack_cost: null, line_total: 480, confidence: 'high' }],
    }),
    OPTS,
  );
  const line = d.lines[0];
  assert.equal(line.quantity, 5);
  assert.equal(line.unitQuantity, 120);
  assert.equal(line.unitCost, 400); // 48000 / 120
  assert.equal(line.unitCostSource, 'computed');
  assert.equal(line.packCost, 9600); // 48000 / 5
  assert.deepEqual(line.flags, ['computed_per_unit']);
});

test('without unit_quantity the behaviour is exactly the old one', () => {
  const d = validateExtraction(
    extraction({
      amount_before_vat: 100,
      vat_amount: 18,
      total_amount: 118,
      lines: [{ name: 'לחם', quantity: 4, unit_quantity: null, unit_cost: null, pack_cost: null, line_total: 100, confidence: 'high' }],
    }),
    OPTS,
  );
  assert.equal(d.lines[0].unitCost, 2500);
  assert.equal(d.lines[0].unitCostSource, 'computed');
  assert.equal(d.lines[0].packCost, null); // no second basis → no carton price
  assert.deepEqual(d.lines[0].flags, ['computed']);
});

test('an explicit unit cost wins over any division; pack cost still derived', () => {
  const d = validateExtraction(
    extraction({
      amount_before_vat: 480,
      vat_amount: 86.4,
      total_amount: 566.4,
      lines: [{ name: 'קולה', quantity: 5, unit_quantity: 120, unit_cost: 4.1, pack_cost: null, line_total: 480, confidence: 'high' }],
    }),
    OPTS,
  );
  assert.equal(d.lines[0].unitCost, 410); // hand-typed/printed value untouched
  assert.equal(d.lines[0].unitCostSource, 'extracted');
  assert.equal(d.lines[0].packCost, 9600);
  assert.deepEqual(d.lines[0].flags, []);
});

test('a printed pack_cost passes through; zero/equal unit_quantity guards hold', () => {
  const printed = validateExtraction(
    extraction({
      lines: [{ name: 'א', quantity: 2, unit_quantity: 24, unit_cost: null, pack_cost: 50, line_total: 100, confidence: 'high' }],
    }),
    OPTS,
  );
  assert.equal(printed.lines[0].packCost, 5000);
  assert.equal(printed.lines[0].unitCost, Math.round(10000 / 24));

  // unit_quantity = 0 → treated as absent (division by quantity, no carton price)
  const zero = validateExtraction(
    extraction({
      lines: [{ name: 'ב', quantity: 4, unit_quantity: 0, unit_cost: null, pack_cost: null, line_total: 100, confidence: 'high' }],
    }),
    OPTS,
  );
  assert.equal(zero.lines[0].unitCost, 2500);
  assert.deepEqual(zero.lines[0].flags, ['computed']);

  // unit_quantity equal to quantity → per-unit basis but no distinct carton price
  const eq = validateExtraction(
    extraction({
      lines: [{ name: 'ג', quantity: 10, unit_quantity: 10, unit_cost: null, pack_cost: null, line_total: 100, confidence: 'high' }],
    }),
    OPTS,
  );
  assert.equal(eq.lines[0].unitCost, 1000);
  assert.equal(eq.lines[0].packCost, null);
});

test('master catalog: hit attaches catalog info; miss+bad checksum flags; miss+valid stays clean', () => {
  const masterCatalog = new Map([
    ['7290000000015', { name: 'חלב תנובה 3% 1 ליטר', manufacturer_name: 'תנובה', quantity: 1, unit_qty: 'ליטר', qty_in_package: 12 }],
  ]);
  const d = validateExtraction(
    extraction({
      lines: [
        { name: 'חלב תנובה 3% 1 ליטר', barcode: '7290000000015', quantity: 2, unit_cost: 5, line_total: 10, confidence: 'high' },
        { name: 'ברקוד שגוי', barcode: '7290000000011', quantity: 1, unit_cost: 3, line_total: 3, confidence: 'high' },
        { name: 'לא בקטלוג', barcode: '4006381333931', quantity: 1, unit_cost: 2, line_total: 2, confidence: 'high' },
        { name: 'קוד פנימי', barcode: '12345', quantity: 1, unit_cost: 1, line_total: 1, confidence: 'high' },
      ],
    }),
    { ...OPTS, masterCatalog },
  );

  const [hit, bad, unknown, internal] = d.lines;
  assert.ok(hit.flags.includes('catalog_match'));
  assert.equal(hit.catalog.name, 'חלב תנובה 3% 1 ליטר');
  assert.equal(hit.catalog.manufacturer, 'תנובה');
  assert.equal(hit.catalog.nameDiffers, false);

  assert.ok(bad.flags.includes('barcode_invalid')); // checksum fails, no catalog hit
  assert.equal(bad.catalog, null);

  assert.deepEqual(unknown.flags, []); // valid checksum, absent from catalog → NOT an error
  assert.deepEqual(internal.flags, []); // non-GTIN shape → no verdict

  const barcodeWarnings = d.warnings.filter((w) => w.code === 'barcode_invalid');
  assert.equal(barcodeWarnings.length, 1); // one aggregated warning
  assert.match(barcodeWarnings[0].message, /בשורות 2/);
});

test('master catalog: nameDiffers true when the extracted name strays from the canonical one', () => {
  const masterCatalog = new Map([
    ['7290000000015', { name: 'חלב תנובה 3% 1 ליטר', manufacturer_name: 'תנובה' }],
  ]);
  const d = validateExtraction(
    extraction({
      lines: [{ name: 'חלב 3', barcode: '7290000000015', quantity: 1, unit_cost: 5, line_total: 5, confidence: 'high' }],
    }),
    { ...OPTS, masterCatalog },
  );
  assert.equal(d.lines[0].catalog.nameDiffers, true);
});

test('without masterCatalog the validator behaves exactly as before (no catalog flags)', () => {
  const d = validateExtraction(
    extraction({
      lines: [{ name: 'א', barcode: '7290000000011', quantity: 1, unit_cost: 5, line_total: 5, confidence: 'high' }],
    }),
    OPTS,
  );
  // No catalog map → checksum still runs (it needs no data), but nothing else changes.
  assert.ok(d.lines[0].flags.includes('barcode_invalid'));
  assert.equal(d.lines[0].catalog, null);
});

test('supplier_phone is carried into the header', () => {
  const d = validateExtraction(extraction({ supplier_phone: '08-6339955' }), OPTS);
  assert.equal(d.header.supplierPhone, '08-6339955');
  const none = validateExtraction(extraction(), OPTS);
  assert.equal(none.header.supplierPhone, null);
});

test('an extracted unit cost passes through untouched', () => {
  const d = validateExtraction(
    extraction({
      amount_before_vat: 99.99,
      vat_amount: 18,
      total_amount: 117.99,
      lines: [{ name: 'חלב', quantity: 3, unit_cost: 33.33, line_total: 99.99, confidence: 'medium' }],
    }),
    OPTS,
  );
  assert.equal(d.lines[0].unitCost, 3333);
  assert.equal(d.lines[0].unitCostSource, 'extracted');
  assert.deepEqual(d.lines[0].flags, []);
});

test('a line with no amounts at all is flagged; low line confidence is flagged', () => {
  const d = validateExtraction(
    extraction({
      lines: [
        { name: 'פריט ללא סכומים', quantity: 1, unit_cost: null, line_total: null, confidence: 'low' },
        { name: 'פריט מטושטש', quantity: 2, unit_cost: 10, line_total: 20, confidence: 'low' },
      ],
    }),
    OPTS,
  );
  assert.deepEqual(d.lines[0].flags, ['missing_amounts', 'low_confidence']);
  assert.equal(d.lines[0].unitCostSource, null);
  assert.deepEqual(d.lines[1].flags, ['low_confidence']);
  assert.equal(d.lines[1].lineNo, 2);
});

test('VAT math tolerance: 100 agorot passes, more is flagged', () => {
  const ok = validateExtraction(extraction({ total_amount: 1181 }), OPTS); // diff = 100
  assert.deepEqual(ok.flags.totalAmount, []);
  assert.deepEqual(ok.flags.amountBeforeVat, []);

  const bad = validateExtraction(extraction({ total_amount: 1182 }), OPTS); // diff = 200
  assert.deepEqual(bad.flags.amountBeforeVat, ['vat_mismatch']);
  assert.deepEqual(bad.flags.vatAmount, ['vat_mismatch']);
  assert.deepEqual(bad.flags.totalAmount, ['vat_mismatch']);
  const w = bad.warnings.find((x) => x.code === 'vat_mismatch');
  assert.ok(w && w.message.includes('2.00'), w && w.message);
});

test('implied VAT rate: 17% is flagged, 18.2% is within tolerance', () => {
  const off = validateExtraction(
    extraction({ vat_amount: 170, total_amount: 1170 }),
    OPTS,
  );
  assert.deepEqual(off.flags.vatAmount, ['vat_rate_off']);
  const w = off.warnings.find((x) => x.code === 'vat_rate_off');
  assert.ok(w.message.includes('17.00%'), w.message);

  const near = validateExtraction(extraction({ vat_amount: 182, total_amount: 1182 }), OPTS);
  assert.deepEqual(near.flags.vatAmount, []);
});

test('lines sum tolerance — 1 ₪ floor on small invoices', () => {
  const base = { amount_before_vat: 100, vat_amount: 18, total_amount: 118 };
  const within = validateExtraction(
    extraction({ ...base, lines: [{ name: 'א', quantity: 1, unit_cost: 100.99, line_total: 100.99, confidence: 'high' }] }),
    OPTS,
  ); // diff = 99 agorot
  assert.deepEqual(within.flags.linesSum, []);

  const outside = validateExtraction(
    extraction({ ...base, lines: [{ name: 'א', quantity: 1, unit_cost: 101.5, line_total: 101.5, confidence: 'high' }] }),
    OPTS,
  ); // diff = 150 agorot
  assert.deepEqual(outside.flags.linesSum, ['lines_sum_mismatch']);
  const w = outside.warnings.find((x) => x.code === 'lines_sum_mismatch');
  assert.ok(w.message.includes('101.50') && w.message.includes('100.00'), w.message);
});

test('lines sum tolerance — 0.5% branch on large invoices', () => {
  const base = { amount_before_vat: 100000, vat_amount: 18000, total_amount: 118000 };
  const mk = (lineTotal) =>
    validateExtraction(
      extraction({ ...base, lines: [{ name: 'א', quantity: 1, unit_cost: lineTotal, line_total: lineTotal, confidence: 'high' }] }),
      OPTS,
    );
  assert.deepEqual(mk(100400).flags.linesSum, []); // 400 ₪ off, tolerance 500 ₪
  assert.deepEqual(mk(100600).flags.linesSum, ['lines_sum_mismatch']); // 600 ₪ off
});

test('credit note keeps absolute amounts and its doc type', () => {
  const d = validateExtraction(
    extraction({
      doc_type: 'credit_note',
      amount_before_vat: -1000,
      vat_amount: -180,
      total_amount: -1180,
      lines: [{ name: 'זיכוי', quantity: 2, unit_cost: -500, line_total: -1000, confidence: 'high' }],
    }),
    OPTS,
  );
  assert.equal(d.header.docType, 'credit_note');
  assert.equal(d.header.amountBeforeVat, 100000);
  assert.equal(d.header.vatAmount, 18000);
  assert.equal(d.header.totalAmount, 118000);
  assert.equal(d.lines[0].unitCost, 50000);
  assert.equal(d.lines[0].lineTotal, 100000);
  assert.deepEqual(d.flags.docType, []);
  assert.deepEqual(d.flags.linesSum, []);
  assert.deepEqual(d.warnings, []);
});

test('unknown or missing doc type defaults to a tax invoice, flagged', () => {
  for (const docType of ['unknown', null, 'משהו אחר']) {
    const d = validateExtraction(extraction({ doc_type: docType }), OPTS);
    assert.equal(d.header.docType, 'tax_invoice');
    assert.deepEqual(d.flags.docType, ['defaulted']);
    assert.ok(codes(d.warnings).includes('defaulted'));
  }
});

test('allocation number: 9 digits kept, anything else nulled and flagged, empty silent', () => {
  const good = validateExtraction(extraction({ allocation_number: '123456789' }), OPTS);
  assert.equal(good.header.allocationNumber, '123456789');
  assert.deepEqual(good.flags.allocationNumber, []);

  const formatted = validateExtraction(extraction({ allocation_number: '123-456 789' }), OPTS);
  assert.equal(formatted.header.allocationNumber, '123456789');
  assert.deepEqual(formatted.flags.allocationNumber, []);

  const short = validateExtraction(extraction({ allocation_number: '12345' }), OPTS);
  assert.equal(short.header.allocationNumber, null);
  assert.deepEqual(short.flags.allocationNumber, ['invalid_format']);
  assert.ok(codes(short.warnings).includes('invalid_format'));

  const empty = validateExtraction(extraction({ allocation_number: null }), OPTS);
  assert.equal(empty.header.allocationNumber, null);
  assert.deepEqual(empty.flags.allocationNumber, []);
  assert.deepEqual(empty.warnings, []);
});

test('parseDateILS converts Israeli date formats', () => {
  assert.equal(parseDateILS('2025-12-31'), '2025-12-31');
  assert.equal(parseDateILS('31/12/2025'), '2025-12-31');
  assert.equal(parseDateILS('05.01.26'), '2026-01-05');
  assert.equal(parseDateILS('5.1.2026'), '2026-01-05');
  assert.equal(parseDateILS('01-02-2026'), '2026-02-01');
  assert.equal(parseDateILS('2026-02-30'), null); // not a real date
  assert.equal(parseDateILS('31/13/2025'), null);
  assert.equal(parseDateILS('לא ברור'), null);
  assert.equal(parseDateILS(null), null);
});

test('invoice date is converted, and an unreadable one is flagged missing', () => {
  const d = validateExtraction(extraction({ invoice_date: '31/12/2025' }), OPTS);
  assert.equal(d.header.invoiceDate, '2025-12-31');
  assert.deepEqual(d.flags.invoiceDate, []);

  const bad = validateExtraction(extraction({ invoice_date: 'לא ברור' }), OPTS);
  assert.equal(bad.header.invoiceDate, null);
  assert.deepEqual(bad.flags.invoiceDate, ['missing']);
  assert.ok(codes(bad.warnings).includes('missing'));
});

test('fields required for commit are flagged when missing', () => {
  const d = validateExtraction(
    extraction({ invoice_number: null, invoice_date: null, amount_before_vat: null, total_amount: null }),
    OPTS,
  );
  for (const f of ['invoiceNumber', 'invoiceDate', 'amountBeforeVat', 'totalAmount']) {
    assert.deepEqual(d.flags[f], ['missing'], f);
  }
  assert.equal(codes(d.warnings).filter((c) => c === 'missing').length, 4);
});

test('low header confidence propagates to the matching field flags', () => {
  const d = validateExtraction(
    extraction({
      field_confidence: {
        supplier_name: 'high',
        invoice_number: 'low',
        allocation_number: 'medium',
        invoice_date: 'low',
        amount_before_vat: 'high',
        vat_amount: 'medium',
        total_amount: 'low',
      },
    }),
    OPTS,
  );
  assert.deepEqual(d.flags.invoiceNumber, ['low_confidence']);
  assert.deepEqual(d.flags.invoiceDate, ['low_confidence']);
  assert.deepEqual(d.flags.totalAmount, ['low_confidence']);
  assert.deepEqual(d.flags.amountBeforeVat, []);
  const w = d.warnings.find((x) => x.code === 'low_confidence');
  assert.ok(w.message.includes('מספר חשבונית'), w.message);
});

test('a fuzzy supplier match is kept but flagged; no match is flagged too', () => {
  const fuzzy = validateExtraction(
    extraction({ supplier_name: 'מאפית הבוקר', supplier_tax_id: null }),
    OPTS,
  );
  assert.equal(fuzzy.header.supplierId, 7);
  assert.equal(fuzzy.header.supplierMethod, 'fuzzy');
  assert.ok(fuzzy.header.supplierScore < 1);
  assert.deepEqual(fuzzy.flags.supplier, ['fuzzy_match']);
  const w = fuzzy.warnings.find((x) => x.code === 'fuzzy_match');
  assert.ok(w.message.includes('מאפיית הבוקר'), w.message); // names the matched supplier

  const none = validateExtraction(
    extraction({ supplier_name: 'ספק שלא קיים במערכת', supplier_tax_id: null }),
    OPTS,
  );
  assert.equal(none.header.supplierId, null);
  assert.equal(none.header.supplierScore, null);
  assert.equal(none.header.supplierMethod, null);
  assert.equal(none.header.supplierName, 'ספק שלא קיים במערכת');
  assert.deepEqual(none.flags.supplier, ['no_supplier_match']);
  assert.ok(codes(none.warnings).includes('no_supplier_match'));
});

test('a containment match is also treated as uncertain', () => {
  const d = validateExtraction(
    extraction({ supplier_name: 'מאפיית הבוקר סניף חיפה', supplier_tax_id: null }),
    OPTS,
  );
  assert.equal(d.header.supplierMethod, 'contains');
  assert.equal(d.header.supplierScore, 0.9);
  assert.deepEqual(d.flags.supplier, ['fuzzy_match']);
});

test('every warning carries a known code and a non-empty Hebrew message', () => {
  const d = validateExtraction(
    {
      supplier_name: 'ספק לא מוכר',
      supplier_tax_id: null,
      invoice_number: null,
      allocation_number: '12345',
      invoice_date: 'לא ברור',
      doc_type: 'unknown',
      amount_before_vat: 1000,
      vat_amount: 170,
      total_amount: 1500,
      lines: [{ name: 'פריט', quantity: 1, unit_cost: null, line_total: 500, confidence: 'low' }],
      field_confidence: { total_amount: 'low' },
      notes: 'החשבונית מקומטת',
    },
    OPTS,
  );
  assert.ok(d.warnings.length >= 6, `got ${d.warnings.length}`);
  for (const w of d.warnings) {
    assert.ok(FLAG_CODES.includes(w.code), `unknown code ${w.code}`);
    assert.equal(typeof w.message, 'string');
    assert.ok(w.message.trim().length > 0);
    assert.match(w.message, /[֐-׿]/); // Hebrew
  }
  const seen = codes(d.warnings);
  for (const c of ['no_supplier_match', 'missing', 'invalid_format', 'defaulted', 'vat_mismatch', 'vat_rate_off', 'lines_sum_mismatch', 'low_confidence']) {
    assert.ok(seen.includes(c), `missing warning ${c}`);
  }
  assert.equal(d.notes, 'החשבונית מקומטת');
  // Flags only ever contain documented codes.
  for (const f of FLAG_FIELDS) {
    for (const code of d.flags[f]) assert.ok(FLAG_CODES.includes(code), `${f}: ${code}`);
  }
});

test('a garbage extraction degrades to an all-missing draft instead of throwing', () => {
  const d = validateExtraction(null, OPTS);
  assert.equal(d.header.supplierId, null);
  assert.equal(d.header.docType, 'tax_invoice');
  assert.deepEqual(d.lines, []);
  assert.deepEqual(d.flags.invoiceNumber, ['missing']);
  assert.equal(d.notes, null);
  const empty = validateExtraction({}, {});
  assert.equal(empty.header.totalAmount, null);
  assert.deepEqual(empty.flags.supplier, ['no_supplier_match']);
});

test('a shortened code resolves to the full barcode — offered, never applied', () => {
  // Exactly the Tnuva case: the invoice prints 42435, the real barcode is 7290000042435.
  const row = (barcode, name) => ({ barcode, name, manufacturer_name: 'תנובה בע"מ', quantity: 1, unit_qty: 'ליטר', qty_in_package: 1 });
  const masterCatalog = {
    exact: new Map(),
    byCode: new Map([['42435', [row('7290000042435', 'חלב מפוסטר 1% בקרטון 1ל')]]]),
  };
  const out = validateExtraction(
    {
      supplier_name: 'תנובה', supplier_tax_id: '', supplier_phone: '', invoice_number: '626093611',
      allocation_number: '', invoice_date: '2026-08-06', doc_type: 'tax_invoice',
      amount_before_vat: 81.28, vat_amount: 14.63, total_amount: 95.91,
      lines: [{ name: 'הומוגני 1% דל', barcode: '42435', sku: '', quantity: 16, unit_quantity: null, unit_cost: 5.08, pack_cost: null, line_total: 81.28, confidence: 'high' }],
      field_confidence: {}, notes: '',
    },
    { suppliers: [], vatRate: 0.18, masterCatalog },
  );
  const line = out.lines[0];
  assert.ok(line.flags.includes('catalog_suffix_match'));
  assert.equal(line.catalog.barcode, '7290000042435');
  assert.equal(line.catalog.name, 'חלב מפוסטר 1% בקרטון 1ל');
  // The extracted value is untouched — the review screen offers the swap, a human takes it.
  assert.equal(line.barcode, '42435');
});

/** Build an extraction whose single line carries `printed` as its description and `code` as מק"ט. */
function draftWithCode(printed, code, masterCatalog, supplierName = 'תנובה') {
  return validateExtraction(
    {
      supplier_name: supplierName, supplier_tax_id: '', supplier_phone: '', invoice_number: '1',
      allocation_number: '', invoice_date: '2026-08-06', doc_type: 'tax_invoice',
      amount_before_vat: 10, vat_amount: 1.8, total_amount: 11.8,
      lines: [{ name: printed, barcode: '', sku: code, quantity: 1, unit_quantity: null, unit_cost: 10, pack_cost: null, line_total: 10, confidence: 'high' }],
      field_confidence: {}, notes: '',
    },
    { suppliers: [], vatRate: 0.18, masterCatalog },
  );
}

const catRow = (barcode, name, manufacturer = null) => ({
  barcode, name, manufacturer_name: manufacturer, quantity: null, unit_qty: null, qty_in_package: null,
});

test('several candidates: the one the line actually describes wins', () => {
  const masterCatalog = {
    exact: new Map(),
    byCode: new Map([['4136857', [catRow('7290004136857', 'גלי פטל 125 גרם'), catRow('7291114136857', 'מוצר אחר')]]]),
  };
  const line = draftWithCode('גלי פטל', '4136857', masterCatalog).lines[0];
  // The code lives in the מק"ט column here, not the barcode column — both are tried.
  assert.ok(line.flags.includes('catalog_suffix_match'));
  assert.equal(line.catalog.barcode, '7290004136857');
  assert.equal(line.catalog.chosenBy, 'name');
  // The alternatives stay on the line, best first, so a wrong pick is one click from corrected.
  assert.deepEqual(line.candidates.map((c) => c.barcode), ['7290004136857', '7291114136857']);
  assert.equal(line.barcode, null); // and nothing was written over the extraction
});

test('when nothing distinguishes the candidates it stays ambiguous', () => {
  const masterCatalog = {
    exact: new Map(),
    byCode: new Map([['42435', [catRow('3664944642435', 'סט אוכל 12 חלקים'), catRow('7290019642435', 'קונפיטורה אפרסק')]]]),
  };
  // A description that matches neither candidate must not be forced onto one of them.
  const line = draftWithCode('פריט כלשהו', '42435', masterCatalog).lines[0];
  assert.ok(line.flags.includes('catalog_ambiguous'));
  assert.equal(line.catalog, null);
  assert.equal(line.candidates.length, 2);
});

test('the supplier who issued the invoice breaks a tie the name cannot', () => {
  // The real case: `42435` returns a ceramic dinner set, Tnuva's milk, and peach jam. "הומוגני 1%
  // דל" shares only "דל" and "1" with the milk — enough on its own, but the fact that Tnuva made
  // it is what makes this unambiguous.
  const masterCatalog = {
    exact: new Map(),
    byCode: new Map([['42435', [
      catRow('3664944642435', 'סט אוכל 12 חלקים קרמ', ','), // the literal junk manufacturer in the real file
      catRow('7290000042435', 'חלב דל שומן בקרטון+פקק 1 ליטר 1%', 'תנובה בע"מ'),
      catRow('7290019642435', 'קונפיטורה אפרסק פסיפלורה ללא סוכר 600 גר'),
    ]]]),
  };
  const line = draftWithCode('הומוגני 1% דל', '42435', masterCatalog, 'תנובה').lines[0];
  assert.ok(line.flags.includes('catalog_suffix_match'));
  assert.equal(line.catalog.barcode, '7290000042435');
  assert.equal(line.catalog.chosenBy, 'supplier+name');
  assert.equal(line.candidates[0].barcode, '7290000042435');
  // `,` is not a manufacturer. Reporting it as one would be noise on screen and, worse, would
  // make two candidates look distinguishable when they are not.
  assert.equal(line.candidates.find((c) => c.barcode === '3664944642435').manufacturer, null);
});

test('a 5-digit code is a suggestion; a 7-digit one is near-certain', () => {
  // Measured on the owner's 80,411-item catalog: 5 digits resolve uniquely 64.5% of the time,
  // 7 digits 99.4%. The same mechanism, very different weight — so the line says which.
  const short = {
    exact: new Map(),
    byCode: new Map([['42435', [catRow('7290000042435', 'חלב דל שומן 1%', 'תנובה')]]]),
  };
  const long = {
    exact: new Map(),
    byCode: new Map([['4136857', [catRow('7290004136857', 'גלי פטל 125 גרם', 'תנובה')]]]),
  };
  assert.equal(draftWithCode('חלב', '42435', short).lines[0].catalog.nearCertain, false);
  assert.equal(draftWithCode('גלי פטל', '4136857', long).lines[0].catalog.nearCertain, true);
});

test('a plain Map of exact barcodes still works (older callers)', () => {
  const masterCatalog = new Map([
    ['7290000042435', { barcode: '7290000042435', name: 'חלב', manufacturer_name: null, quantity: null, unit_qty: null, qty_in_package: null }],
  ]);
  const out = validateExtraction(
    {
      supplier_name: 'תנובה', supplier_tax_id: '', supplier_phone: '', invoice_number: '1',
      allocation_number: '', invoice_date: '2026-08-06', doc_type: 'tax_invoice',
      amount_before_vat: 10, vat_amount: 1.8, total_amount: 11.8,
      lines: [{ name: 'חלב', barcode: '7290000042435', sku: '', quantity: 1, unit_quantity: null, unit_cost: 10, pack_cost: null, line_total: 10, confidence: 'high' }],
      field_confidence: {}, notes: '',
    },
    { suppliers: [], vatRate: 0.18, masterCatalog },
  );
  assert.ok(out.lines[0].flags.includes('catalog_match'));
});
