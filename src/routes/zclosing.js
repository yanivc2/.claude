import { Router } from 'express';
import {
  createZClosing, listZClosings, getZClosing, updateZClosing, deleteZClosing,
  listClosingExpenses, recentClosingExpenses, CLOSING_DENOMS, israelNow,
} from '../services/zclosing.js';
import { getExecutor } from '../db/adapter.js';
import { scopeClause } from '../lib/scope.js';
import { toAgorot } from '../lib/money.js';
import { listInvoices } from '../services/invoices.js';
import { listEmployees } from '../services/employees.js';
import { requireOwner } from '../middleware/requireOwner.js';
import { RuleError } from '../lib/errors.js';

const router = Router();

// Stores the closer may pick — limited to the companies granted to them (owner sees all).
async function storeOptionsFor(req) {
  const sc = scopeClause(req.scope?.companyIds ?? null, 'c.id');
  return getExecutor().many(
    `SELECT st.id, st.name, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id
      WHERE 1 = 1${sc.sql} ORDER BY c.name, st.name`,
    [...sc.params],
  );
}

// Recent invoices offered as match targets for a cash expense (מס' · ספק · סכום). Scoped, capped.
async function invoicePickOptions(scope) {
  const rows = await listInvoices({ scope });
  return rows.slice(0, 300).map((r) => ({
    id: r.id,
    invoice_number: r.invoice_number,
    supplier_name: r.supplier_name,
    total_amount: r.total_amount,
  }));
}

// Build the createZClosing/updateZClosing input from the posted form body. Cash expenses now carry
// a kind (manual/salary/advance/invoice) + date + employee/invoice link — same shape as the Z report.
function closingInputFrom(b) {
  const counts = {};
  for (const d of CLOSING_DENOMS) counts[d.key] = Number(b[`count_${d.key}`] || 0);
  const dates = [].concat(b.expense_date || []);
  const names = [].concat(b.payer_name || []);
  const purposes = [].concat(b.purpose || []);
  const amounts = [].concat(b.amount || []);
  const invoiceIds = [].concat(b.expense_invoice_id || []);
  const kinds = [].concat(b.expense_kind || []);
  const employeeIds = [].concat(b.expense_employee_id || []);
  const expenses = amounts.map((a, i) => ({
    expenseDate: dates[i] || null,
    payerName: names[i],
    purpose: purposes[i],
    kind: kinds[i] || 'manual',
    employeeId: employeeIds[i] || null,
    amount: a != null && String(a).trim() !== '' ? toAgorot(a) : 0,
    invoiceId: invoiceIds[i] || null,
  }));

  // "איזון קופות" — one repeatable register block posts parallel arrays; zip them by index.
  const rFirst = [].concat(b.reg_first || []);
  const rLast = [].concat(b.reg_last || []);
  const rNum = [].concat(b.reg_number || []);
  const rStore = [].concat(b.reg_store || []);
  const rCounts = {};
  for (const d of CLOSING_DENOMS) rCounts[d.key] = [].concat(b[`reg_count_${d.key}`] || []);
  const regN = Math.max(rFirst.length, rLast.length, rNum.length, rStore.length, ...CLOSING_DENOMS.map((d) => rCounts[d.key].length));
  const registers = [];
  for (let i = 0; i < regN; i++) {
    const rc = {};
    for (const d of CLOSING_DENOMS) rc[d.key] = Number(rCounts[d.key][i] || 0);
    registers.push({ first: rFirst[i], last: rLast[i], register: rNum[i], storeId: rStore[i] || null, counts: rc });
  }

  return {
    employeeFirst: b.employee_first,
    employeeLast: b.employee_last,
    employeeId: b.employee_id || null,
    storeId: b.store_id || null,
    zNumber: b.z_number,
    drawerCash: toAgorot(b.drawer_cash || '0'),
    startedAt: b.started_at,
    counts,
    expenses,
    registers,
  };
}

async function render(req, res, extra = {}) {
  res.render('zclosing/index', {
    title: 'סגירת Z',
    denoms: CLOSING_DENOMS,
    storeOptions: await storeOptionsFor(req),
    employeeOptions: await listEmployees(),
    invoiceOptions: await invoicePickOptions(req.scope?.companyIds ?? null),
    startedAt: israelNow(),
    closings: await listZClosings({ limit: 30 }),
    closingExpenses: await recentClosingExpenses(req.scope?.companyIds ?? null, 30),
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await render(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    await createZClosing(closingInputFrom(req.body), req.user);
    await render(req, res, { notice: 'הסגירה נשמרה. תודה!' });
  } catch (err) {
    if (err instanceof RuleError) return render(req, res, { error: err.message });
    next(err);
  }
});

// --- View / edit / delete a saved closing (owner only — a cashier only creates). ---
async function renderEdit(req, res, id, extra = {}) {
  const closing = await getZClosing(id);
  let breakdown = {};
  try { breakdown = JSON.parse(closing.breakdown || '{}'); } catch { breakdown = {}; }
  const expenses = await listClosingExpenses(id);
  res.render('zclosing/edit', {
    title: `עריכת סגירת Z`,
    closing,
    breakdown,
    expenses,
    denoms: CLOSING_DENOMS,
    storeOptions: await storeOptionsFor(req),
    employeeOptions: await listEmployees(),
    invoiceOptions: await invoicePickOptions(req.scope?.companyIds ?? null),
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/:id', requireOwner, async (req, res, next) => {
  try {
    await renderEdit(req, res, Number(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/:id', requireOwner, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    await updateZClosing(id, closingInputFrom(req.body), req.user);
    await render(req, res, { notice: 'הסגירה עודכנה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderEdit(req, res, id, { error: err.message });
    next(err);
  }
});

router.post('/:id/delete', requireOwner, async (req, res, next) => {
  try {
    await deleteZClosing(Number(req.params.id), req.user);
    await render(req, res, { notice: 'הסגירה נמחקה.' });
  } catch (err) {
    next(err);
  }
});

export default router;
