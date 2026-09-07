// R3 (מספר הקצאה) tests the VAT on the invoice, not the amount before VAT.
//
// THE CASE: a fruit-and-vegetable supplier hands over a ₪20,000 invoice with no allocation number
// on it, and there is nothing to chase — fresh unprocessed produce is ZERO-RATED under §30(א)(13)
// of the VAT Law, so the invoice carries ₪0 VAT, and the Tax Authority's own Q&A says the
// criterion for needing an allocation number is the VAT amount ("הקריטריון … הוא סכום המע"מ"),
// which on a mixed invoice stays the VAT amount "regardless of whether it contains exempt
// transactions or zero-rated items". Testing the net amount soft-blocked (on_hold) every one of
// that supplier's invoices for a number that does not exist and cannot be obtained.
//
// For an ordinary 18% supplier the two tests are the same test (5,000 × 18% = 900), so none of
// this loosens anything — which is what the first case below pins down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { config } from '../src/config.js';
import {
  createInvoice, updateInvoice, getInvoice, requiresAllocationNumber, zeroVatNeedsCheck,
  approveInvoiceForPayment, getInvoiceDetail,
} from '../src/services/invoices.js';
import { createSupplier, approveSupplier, updateSupplier, getSupplier } from '../src/services/suppliers.js';

const NET = config.rules.allocationThresholdAgorot;      // 5,000 ₪
const VATT = config.rules.allocationVatThresholdAgorot;  // 900 ₪
const vatOn = (net) => Math.round(net * config.vatRate);

async function ctx(supplierFields = {}) {
  const db = await freshDb();
  const own = await owner(db);
  const sec = await secretary(db);
  const store = await firstStore(db);
  const sup = await approveSupplier(
    (await createSupplier({ name: 'ירקן השדה', ...supplierFields }, sec, db)).id, own, db,
  );
  return { db, own, sec, store, sup };
}
const inv = (sup, store, over = {}) => ({
  supplierId: sup.id, storeId: store.id, invoiceNumber: 'Z-1', invoiceDate: '2026-07-01',
  amountBeforeVat: NET * 4, vatAmount: vatOn(NET * 4), docType: 'tax_invoice', ...over,
});

test('the two thresholds agree: 5,000 ₪ net at 18% is exactly the 900 ₪ VAT figure', () => {
  assert.equal(VATT, Math.round(NET * config.vatRate));
  assert.equal(VATT, 900 * 100, 'the VAT figure from 1.6.2026');
});

test('an ordinary 18% invoice over the threshold is still held — nothing was loosened', async () => {
  const { db, sec, store, sup } = await ctx();
  const { invoice } = await createInvoice(inv(sup, store), sec, db);
  assert.equal(invoice.status, 'on_hold');
  assert.match(invoice.hold_reason, /^R3/);
});

test('a ₪20,000 ZERO-RATED produce invoice is NOT held — no allocation number is required', async () => {
  const { db, sec, store, sup } = await ctx();
  const { invoice } = await createInvoice(inv(sup, store, { amountBeforeVat: 2000000, vatAmount: 0 }), sec, db);
  assert.equal(invoice.status, 'recorded', 'fresh produce carries no VAT and needs no allocation');
  assert.equal(invoice.hold_reason, null);
  assert.equal(requiresAllocationNumber(invoice), false);
});

test('a MIXED invoice is judged on ITS VAT: below the figure clear, above it held', async () => {
  const { db, sec, store, sup } = await ctx();
  // ₪30,000 of produce (0%) plus ₪2,000 of packaged goods at 18% = ₪360 VAT → under 900 → clear.
  const { invoice: low } = await createInvoice(
    inv(sup, store, { invoiceNumber: 'MIX-LOW', amountBeforeVat: 3200000, vatAmount: 36000 }), sec, db,
  );
  assert.equal(low.status, 'recorded');

  // Same shape, but ₪8,000 of standard-rated goods = ₪1,440 VAT → over 900 → held.
  const { invoice: high } = await createInvoice(
    inv(sup, store, { invoiceNumber: 'MIX-HIGH', amountBeforeVat: 3800000, vatAmount: 144000, invoiceDate: '2026-07-02' }), sec, db,
  );
  assert.equal(high.status, 'on_hold');
});

test('editing the VAT moves the hold in both directions', async () => {
  const { db, own, sec, store, sup } = await ctx();
  const { invoice } = await createInvoice(inv(sup, store, { amountBeforeVat: 2000000, vatAmount: 0 }), sec, db);
  assert.equal(invoice.status, 'recorded');

  // The VAT was in fact forgotten — correcting it up must place the R3 hold.
  await updateInvoice(invoice.id, { vatAmount: vatOn(2000000) }, own, db);
  assert.equal((await getInvoice(invoice.id, db)).status, 'on_hold');

  // …and correcting it back to a genuine zero-rated supply must clear it again.
  await updateInvoice(invoice.id, { vatAmount: 0 }, own, db);
  const back = await getInvoice(invoice.id, db);
  assert.equal(back.status, 'recorded');
  assert.equal(back.hold_reason, null);
});

test('a zero-rated produce invoice is payable without an owner override', async () => {
  const { db, sec, store, sup } = await ctx();
  const { invoice } = await createInvoice(inv(sup, store, { amountBeforeVat: 2000000, vatAmount: 0 }), sec, db);
  // A secretary has no hold_invoice permission; before the fix this threw (R3/on_hold).
  const approved = await approveInvoiceForPayment(invoice.id, sec, db);
  assert.equal(approved.status, 'approved_for_payment');
});

test('a credit note never needs one, whatever its VAT', async () => {
  const { db, sec, store, sup } = await ctx();
  const { invoice } = await createInvoice(
    inv(sup, store, { invoiceNumber: 'CN-1', docType: 'credit_note', amountBeforeVat: -2000000, vatAmount: -360000 }), sec, db,
  );
  assert.equal(invoice.status, 'recorded');
  assert.equal(requiresAllocationNumber(invoice), false);
});

// --- the forgotten-VAT safety net --------------------------------------------------------------

test('a big tax invoice with no VAT is flagged for review — unless the supplier is zero-rated', async () => {
  const { db, own, sec, store, sup } = await ctx();
  const { invoice } = await createInvoice(inv(sup, store, { amountBeforeVat: 2000000, vatAmount: 0 }), sec, db);

  const before = await getInvoiceDetail(invoice.id, db);
  assert.equal(zeroVatNeedsCheck(before), true, 'ask once: was the VAT forgotten?');

  // The owner marks the supplier as a zero-rated (produce) supplier → the reminder stops.
  await updateSupplier(sup.id, { name: sup.name, zeroRated: true }, own, db);
  assert.equal(Number((await getSupplier(sup.id, db)).zero_rated), 1);
  const after = await getInvoiceDetail(invoice.id, db);
  assert.equal(zeroVatNeedsCheck(after), false);

  // Marking the supplier must NOT bypass R3 itself — a mixed invoice with real VAT still holds.
  const { invoice: mixed } = await createInvoice(
    inv(sup, store, { invoiceNumber: 'MIX-2', amountBeforeVat: 2000000, vatAmount: vatOn(2000000) }), sec, db,
  );
  assert.equal(mixed.status, 'on_hold', 'the flag silences a reminder, it never waives the law');
});

test('the reminder is silent below the net figure, and once an allocation number is present', async () => {
  const { db, sec, store, sup } = await ctx();
  const { invoice: small } = await createInvoice(
    inv(sup, store, { invoiceNumber: 'S-1', amountBeforeVat: 100000, vatAmount: 0 }), sec, db,
  );
  assert.equal(zeroVatNeedsCheck(await getInvoiceDetail(small.id, db)), false);

  const { invoice: withAlloc } = await createInvoice(
    inv(sup, store, { invoiceNumber: 'S-2', amountBeforeVat: 2000000, vatAmount: 0, allocationNumber: '123456789' }), sec, db,
  );
  assert.equal(zeroVatNeedsCheck(await getInvoiceDetail(withAlloc.id, db)), false);
});
