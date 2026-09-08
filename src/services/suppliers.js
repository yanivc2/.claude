import { getExecutor, nowTs } from '../db/adapter.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { userCan } from '../lib/permissions.js';
import { filterByStoreLinks, scopedStoreList } from '../lib/scope.js';
import { validateBankDetails, guessBankCode } from '../lib/banks.js';
import { logAction } from './audit.js';

/** Count suppliers awaiting owner approval — feeds the "אישורים" nav badge. Tolerant pre-upgrade. */
export async function countPendingSuppliers(x = getExecutor()) {
  try {
    const r = await x.one("SELECT COUNT(*) AS n FROM suppliers WHERE status = 'pending'", []);
    return Number(r?.n || 0);
  } catch {
    return 0;
  }
}

/** List suppliers, optionally filtered by status, ordered by name. Each row gets a `stores`
 *  array ([{id,name}]) of the stores it's assigned to. */
export async function listSuppliers(status = null, x = getExecutor(), { scope = null } = {}) {
  const rows = status
    ? await x.many('SELECT * FROM suppliers WHERE status = ? ORDER BY name', [status])
    : await x.many('SELECT * FROM suppliers ORDER BY name', []);
  // SCOPED through supplier_stores (lib/scope.js#filterByStoreLinks): a supplier with no store
  // links is shared with everyone; one with links belongs only to those stores' companies. The
  // `stores` array it attaches is the same one attachStores used to build.
  if (scope !== null) return filterByStoreLinks(rows, 'supplier_stores', 'supplier_id', scope, x);
  return attachStores(rows, x);
}

// Attach each supplier's assigned stores (fetched in one query, grouped in JS — portable across
// SQLite/Postgres). Tolerates a pre-upgrade DB without the supplier_stores table.
async function attachStores(rows, x = getExecutor()) {
  if (!rows || rows.length === 0) return rows;
  let links = [];
  try {
    links = await x.many(
      `SELECT ss.supplier_id, ss.store_id, st.name AS store_name
         FROM supplier_stores ss JOIN stores st ON st.id = ss.store_id
        ORDER BY st.name`,
      [],
    );
  } catch {
    return rows.map((r) => ({ ...r, stores: [] }));
  }
  const byS = new Map();
  for (const l of links) {
    if (!byS.has(l.supplier_id)) byS.set(l.supplier_id, []);
    byS.get(l.supplier_id).push({ id: l.store_id, name: l.store_name });
  }
  return rows.map((r) => ({ ...r, stores: byS.get(r.id) || [] }));
}

export async function getSupplier(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM suppliers WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`ספק ${id} לא נמצא`);
  const [withStores] = await attachStores([row], x);
  return withStores;
}

/** The store ids a supplier is assigned to. */
export async function getSupplierStoreIds(supplierId, x = getExecutor()) {
  try {
    const rows = await x.many('SELECT store_id FROM supplier_stores WHERE supplier_id = ?', [supplierId]);
    return rows.map((r) => r.store_id);
  } catch {
    return [];
  }
}

/** Replace a supplier's store assignments with the given store ids (owner/manage_suppliers). */
export async function setSupplierStores(supplierId, storeIds = [], x = getExecutor()) {
  const ids = [...new Set((storeIds || []).map(Number).filter(Boolean))];
  await x.run('DELETE FROM supplier_stores WHERE supplier_id = ?', [supplierId]);
  for (const sid of ids) {
    await x.run('INSERT INTO supplier_stores (supplier_id, store_id) VALUES (?, ?)', [supplierId, sid]);
  }
}

/**
 * Create a supplier. Always starts as `pending` (§6.2) — the secretary may keep
 * recording invoices against it, but payment is blocked until an owner approves (R1/R6).
 */
export async function createSupplier(
  { name, taxId = null, notes = null, phone = null, email = null, contactName = null, contactPhone = null, paymentMethod = null, paymentTerms = null, zeroRated = false, storeIds = null },
  actor,
  x = getExecutor(),
) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new RuleError('VALIDATION', 'שם ספק חובה');

  const info = await x.run(
    `INSERT INTO suppliers (name, tax_id, status, notes, phone, email, contact_name, contact_phone, payment_method, payment_terms, zero_rated)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trimmed,
      taxId?.trim() || null,
      notes?.trim() || null,
      phone?.trim() || null,
      email?.trim() || null,
      contactName?.trim() || null,
      contactPhone?.trim() || null,
      paymentMethod?.trim() || null,
      paymentTerms?.trim() || null,
      zeroRated ? 1 : 0,
    ],
  );

  if (Array.isArray(storeIds)) await setSupplierStores(info.lastInsertRowid, storeIds, x);

  await logAction(
    { userId: actor.id, action: 'supplier.create', entityType: 'supplier', entityId: info.lastInsertRowid, details: { name: trimmed } },
    x,
  );
  return getSupplier(info.lastInsertRowid, x);
}

/** Update a supplier's contact details (phone/email/bookkeeping contact). */
export async function updateSupplierContacts(
  id,
  { phone = null, email = null, contactName = null, contactPhone = null },
  actor,
  x = getExecutor(),
) {
  await getSupplier(id, x);
  await x.run(
    'UPDATE suppliers SET phone = ?, email = ?, contact_name = ?, contact_phone = ? WHERE id = ?',
    [
      phone?.trim() || null,
      email?.trim() || null,
      contactName?.trim() || null,
      contactPhone?.trim() || null,
      id,
    ],
  );
  await logAction({ userId: actor.id, action: 'supplier.update_contacts', entityType: 'supplier', entityId: id }, x);
  return getSupplier(id, x);
}

/** Update a supplier's full details (name / tax id / notes / contacts). */
export async function updateSupplier(
  id,
  { name, taxId = null, notes = null, phone = null, email = null, contactName = null, contactPhone = null, paymentMethod = null, paymentTerms = null, zeroRated = false, storeIds = null, parentSupplierId = undefined },
  actor,
  x = getExecutor(),
) {
  await getSupplier(id, x);
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new RuleError('VALIDATION', 'שם ספק חובה');
  const parentId = parentSupplierId === undefined ? undefined : await validateParent(id, parentSupplierId, x);
  await x.run(
    `UPDATE suppliers SET name = ?, tax_id = ?, notes = ?, phone = ?, email = ?, contact_name = ?, contact_phone = ?,
            payment_method = ?, payment_terms = ?, zero_rated = ?${parentId === undefined ? '' : ', parent_supplier_id = ?'}
     WHERE id = ?`,
    [
      trimmed,
      taxId?.trim() || null,
      notes?.trim() || null,
      phone?.trim() || null,
      email?.trim() || null,
      contactName?.trim() || null,
      contactPhone?.trim() || null,
      paymentMethod?.trim() || null,
      paymentTerms?.trim() || null,
      zeroRated ? 1 : 0,
      ...(parentId === undefined ? [] : [parentId]),
      id,
    ],
  );
  if (Array.isArray(storeIds)) await setSupplierStores(id, storeIds, x);
  await logAction({ userId: actor.id, action: 'supplier.update', entityType: 'supplier', entityId: id }, x);
  return getSupplier(id, x);
}

/**
 * Validate a subsidiary→parent link (returns the normalized parent id, or null to unlink).
 * Kept to a single level: the chosen parent must be a top-level supplier, this supplier must not
 * itself be a parent, and no self-parenting — so a payment "family" is always exactly root + kids.
 */
async function validateParent(id, parentSupplierId, x) {
  const pid = Number(parentSupplierId) || null;
  if (pid === null) return null; // unlink
  if (pid === Number(id)) throw new RuleError('VALIDATION', 'ספק לא יכול להיות חברת-בת של עצמו');
  const parent = await x.one('SELECT id, parent_supplier_id FROM suppliers WHERE id = ?', [pid]);
  if (!parent) throw new NotFoundError(`ספק ${pid} לא נמצא`);
  if (parent.parent_supplier_id != null) {
    throw new RuleError('VALIDATION', 'חברת-האם הנבחרת היא עצמה חברת-בת — בחר חברת-אם ברמה העליונה');
  }
  const kids = await x.one('SELECT COUNT(*) AS n FROM suppliers WHERE parent_supplier_id = ?', [id]);
  if (Number(kids.n) > 0) {
    throw new RuleError('VALIDATION', 'ספק זה הוא חברת-אם של ספקים אחרים — לא ניתן להגדיר לו חברת-אם');
  }
  return pid;
}

/**
 * The supplier ids in one payment "family" — a parent and all its subsidiaries — so their open
 * invoices can be paid together in a single payment (e.g. קוקה קולה + טרה). For a top-level
 * supplier the root is itself; for a subsidiary the root is its parent. Returns unique ids.
 */
export async function supplierFamilyIds(supplierId, x = getExecutor()) {
  const s = await x.one('SELECT id, parent_supplier_id FROM suppliers WHERE id = ?', [supplierId]);
  if (!s) return [Number(supplierId)];
  const rootId = s.parent_supplier_id != null ? Number(s.parent_supplier_id) : Number(s.id);
  const kids = await x.many('SELECT id FROM suppliers WHERE parent_supplier_id = ?', [rootId]);
  return [...new Set([rootId, ...kids.map((k) => Number(k.id))])];
}

/** Quick supplier search by name / tax id / phone / contact — for the dashboard search box. */
export async function searchSuppliers(query, scope = null, x = getExecutor()) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;
  const rows = await x.many(
    `SELECT * FROM suppliers
      WHERE name LIKE ? OR tax_id LIKE ? OR phone LIKE ? OR contact_name LIKE ? OR contact_phone LIKE ?
      ORDER BY name LIMIT 20`,
    [like, like, like, like, like],
  );
  // Search is a read of the same data as the list — it has to obey the same separation.
  return scope === null ? rows : filterByStoreLinks(rows, 'supplier_stores', 'supplier_id', scope, x);
}

/**
 * Approve a supplier — owner only (R6). Records approver + timestamp and audits.
 */
export async function approveSupplier(id, actor, x = getExecutor()) {
  requireOwner(actor);
  const supplier = await getSupplier(id, x);
  if (supplier.status === 'approved') return supplier;

  await x.run(
    `UPDATE suppliers SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`,
    [actor.id, nowTs(), id],
  );

  await logAction({ userId: actor.id, action: 'supplier.approve', entityType: 'supplier', entityId: id }, x);
  return getSupplier(id, x);
}

/** Block a supplier — owner only (R6). Blocked suppliers can never be paid (R1). */
export async function blockSupplier(id, actor, reason = null, x = getExecutor()) {
  requireOwner(actor);
  await getSupplier(id, x);
  await x.run("UPDATE suppliers SET status = 'blocked' WHERE id = ?", [id]);
  await logAction(
    { userId: actor.id, action: 'supplier.block', entityType: 'supplier', entityId: id, details: { reason } },
    x,
  );
  return getSupplier(id, x);
}

/**
 * Delete a supplier — owner only. Refused if any invoice references it (block it instead, so
 * history is preserved). Intended for cleaning up mistaken/duplicate entries.
 */
export async function deleteSupplier(id, actor, x = getExecutor()) {
  requireOwner(actor);
  await getSupplier(id, x);
  const used = await x.one('SELECT COUNT(*) AS n FROM invoices WHERE supplier_id = ?', [id]);
  if (used.n > 0) {
    throw new RuleError('IN_USE', `לספק זה יש ${used.n} חשבוניות — לא ניתן למחוק. חסום אותו במקום.`);
  }
  await x.run('DELETE FROM supplier_stores WHERE supplier_id = ?', [id]);
  await x.run('DELETE FROM suppliers WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'supplier.delete', entityType: 'supplier', entityId: id }, x);
}

function requireOwner(actor) {
  if (!userCan(actor, 'manage_suppliers')) {
    throw new AuthError('אישור/חסימת/מחיקת ספק — נדרשת הרשאת ניהול ספקים (R6)');
  }
}

// ── ספקים בשיעור אפס (§30(א)(13)) ──────────────────────────────────────────────────────────────

/** Set/clear the zero-rated flag on several suppliers at once (owner action). */
export async function setSuppliersZeroRated(ids, on, actor, x = getExecutor()) {
  const list = [...new Set((ids || []).map(Number).filter(Boolean))];
  for (const id of list) {
    await x.run('UPDATE suppliers SET zero_rated = ? WHERE id = ?', [on ? 1 : 0, id]);
    await logAction(
      { userId: actor?.id ?? null, action: on ? 'supplier.zero_rated_on' : 'supplier.zero_rated_off', entityType: 'supplier', entityId: id },
      x,
    );
  }
  return list.length;
}

// A weak hint only — a name never marks anybody by itself. It is here so a supplier with no
// invoices yet still surfaces in the list for a human to judge.
const PRODUCE_WORDS = ['פירות', 'ירקות', 'ירקן', 'תוצרת', 'חקלא', 'פרדס', 'מטע', 'משתלה', 'בוסתן'];

/**
 * Which suppliers look like zero-rated (fresh produce) suppliers — from THEIR OWN INVOICES, not
 * from their names. For each supplier: how many tax invoices it has, and how many of those carried
 * no VAT. A supplier whose every tax invoice is VAT-free is what a produce supplier looks like in
 * the data; that is the only thing that pre-ticks a row. The name hint is shown but never decides.
 *
 * Deliberately two simple queries + a JS join: pg-mem (the Postgres dialect the tests run against)
 * refuses a GROUP BY over a join, and this is a handful of rows either way.
 *
 * @returns {Promise<Array<{id, name, zero_rated, invoices, zeroVat, share, nameHint, suggested}>>}
 */
export async function zeroRatedCandidates(scope = null, x = getExecutor()) {
  const suppliers = await listSuppliers(null, x, { scope });
  const rows = await x.many(
    `SELECT supplier_id,
            COUNT(*) AS n,
            SUM(CASE WHEN vat_amount = 0 THEN 1 ELSE 0 END) AS nz
       FROM invoices
      WHERE doc_type = 'tax_invoice'
      GROUP BY supplier_id`,
    [],
  );
  const byId = new Map(rows.map((r) => [Number(r.supplier_id), { n: Number(r.n), nz: Number(r.nz) }]));

  return suppliers
    .map((s) => {
      const agg = byId.get(Number(s.id)) || { n: 0, nz: 0 };
      const share = agg.n ? agg.nz / agg.n : 0;
      const nameHint = PRODUCE_WORDS.some((w) => String(s.name || '').includes(w));
      return {
        id: Number(s.id),
        name: s.name,
        zero_rated: Number(s.zero_rated) ? 1 : 0,
        invoices: agg.n,
        zeroVat: agg.nz,
        share,
        nameHint,
        // Measured, not assumed: every tax invoice this supplier ever filed carried no VAT.
        suggested: agg.n >= 1 && agg.nz === agg.n,
      };
    })
    .filter((c) => c.zero_rated || c.suggested || c.nameHint)
    .sort((a, b) => (b.suggested - a.suggested) || (b.invoices - a.invoices) || a.name.localeCompare(b.name, 'he'));
}

/**
 * Which stores a supplier ACTUALLY buys for, measured from the invoices it has filed.
 *
 * Why this exists: `filterByStoreLinks` deliberately treats a supplier with no `supplier_stores`
 * row as shared with every store — never hidden, so nothing vanished when the link table was
 * introduced. The consequence is that until a supplier is assigned, choosing a branch does not
 * narrow the supplier list at all, and the screen looks like it is leaking other branches' data
 * when it is only showing unassigned ones. The fix is to assign them — and the invoices already
 * say where each supplier delivers, so nobody has to remember.
 *
 * Only suppliers with NO links are offered (assigning an already-assigned supplier is a decision
 * someone made). A supplier that invoiced two branches gets both — one supplier, two branches, as
 * the link table was designed for.
 *
 * Two flat queries + a JS join: pg-mem refuses a GROUP BY over a join, and this is a small list.
 *
 * @param scope the ASSIGNMENT scope (unnarrowed grants) — this is a management action, like the
 *              "העתק לחנות" pickers, so it must see every store the user may assign to.
 * @returns {Promise<Array<{id,name,invoices,stores:Array<{id,name,company_name,n}>}>>}
 */
export async function supplierStoreSuggestions(scope = null, x = getExecutor()) {
  const suppliers = (await listSuppliers(null, x, { scope })).filter((s) => !(s.stores || []).length);
  if (!suppliers.length) return [];

  const allowed = await scopedStoreList(scope, x);
  const byStore = new Map(allowed.map((st) => [Number(st.id), st]));
  const counts = await x.many(
    'SELECT supplier_id, store_id, COUNT(*) AS n FROM invoices GROUP BY supplier_id, store_id',
    [],
  );

  const bySupplier = new Map();
  for (const r of counts) {
    const st = byStore.get(Number(r.store_id));
    if (!st) continue; // a store outside the caller's grants is never named back to them
    const k = Number(r.supplier_id);
    if (!bySupplier.has(k)) bySupplier.set(k, []);
    bySupplier.get(k).push({ id: st.id, name: st.name, company_name: st.company_name, n: Number(r.n) });
  }

  return suppliers
    .map((s) => {
      const stores = (bySupplier.get(Number(s.id)) || []).sort((a, b) => b.n - a.n);
      return { id: Number(s.id), name: s.name, stores, invoices: stores.reduce((t, st) => t + st.n, 0) };
    })
    .filter((c) => c.stores.length)   // nothing to infer for a supplier that never invoiced
    .sort((a, b) => b.invoices - a.invoices || a.name.localeCompare(b.name, 'he'));
}

// ── פרטי בנק של ספק ────────────────────────────────────────────────────────────────────────────
//
// THE FRAUD THIS GUARDS: the dangerous transfer is not one for a fake invoice. It is a REAL invoice,
// a real amount, correctly approved — paid into an account that was quietly changed. An email from
// "the supplier" announcing new bank details is how a business this size actually loses money, and
// nothing about the invoice looks wrong at all.
//
// So: the destination lives on the supplier, changing it is an OWNER act, every change is kept with
// who and when, and a transfer to a supplier whose details changed recently says so at the moment
// of approval (see services/transfers.js). The window is deliberately generous — a fraudster's
// change and the payment it targets are usually days apart, not minutes.
export const BANK_CHANGE_WARN_DAYS = 60;

const BANK_FIELDS = ['bank_name', 'bank_branch', 'bank_account', 'bank_holder'];
const clean = (v) => (v ?? '').toString().trim() || null;

/**
 * החשבון שאליו מותר להעביר כסף לספק זה, עבור חנות מסוימת.
 *
 * זו ההכרעה היחידה בקוד לשאלה "לאן הכסף הולך", ולכן גם המסך, גם טביעת האצבע של ההעברה
 * (services/transfers.js#substanceOf) וגם הבדיקה לפני הביצוע קוראים לה — אחרת המסך היה יכול
 * להראות חשבון אחד והכסף ללכת לאחר.
 *
 * הכלל: חשבון ייעודי לחנות גובר על חשבון ברירת המחדל של הספק. אין אף אחד מהם → null.
 */
export async function supplierBankFor(supplierId, storeId = null, x = getExecutor()) {
  let rows;
  try {
    rows = await x.many('SELECT * FROM supplier_bank_accounts WHERE supplier_id = ?', [Number(supplierId)]);
  } catch {
    return null; // מסד לפני העדכון
  }
  const forStore = storeId ? rows.find((r) => Number(r.store_id) === Number(storeId)) : null;
  const fallback = rows.find((r) => r.store_id == null) || null;
  const hit = forStore || fallback;
  if (!hit) return null;
  return { ...hit, resolved_from: forStore ? 'store' : 'default' };
}

/** כל חשבונות הספק — שורת ברירת המחדל ראשונה, אחריה החנויות לפי שם. */
export async function listSupplierBankAccounts(supplierId, x = getExecutor()) {
  let rows;
  try {
    rows = await x.many(
      `SELECT a.*, st.name AS store_name, u.name AS verified_by_name
         FROM supplier_bank_accounts a
         LEFT JOIN stores st ON st.id = a.store_id
         LEFT JOIN users u ON u.id = a.verified_by
        WHERE a.supplier_id = ?`,
      [Number(supplierId)],
    );
  } catch {
    return []; // מסד לפני העדכון
  }
  return rows
    .map((r) => ({
      ...r,
      // רשומה שהועברה מהמבנה הישן נושאת שם בנק בלי קוד. מציעים קוד — לא כותבים אותו בשקט.
      suggested_bank_code: !r.bank_code && r.bank_name ? guessBankCode(r.bank_name) : null,
      changedRecently: bankChangedRecently(r),
    }))
    .sort((a, b) => {
      if ((a.store_id == null) !== (b.store_id == null)) return a.store_id == null ? -1 : 1;
      return String(a.store_name || '').localeCompare(String(b.store_name || ''), 'he');
    });
}

const EXTRA_FIELDS = ['bank_code', 'holder_tax_id', 'iban'];
const extraJson = (row) => JSON.stringify(Object.fromEntries(EXTRA_FIELDS.map((f) => [f, row?.[f] ?? null])));

/**
 * קביעה או שינוי של חשבון בנק לספק (לחנות מסוימת, או ברירת המחדל). בעלים בלבד.
 *
 * שינוי לעולם אינו שקט: הערכים הקודמים נכתבים ל-supplier_bank_changes ונשלח פוש, כדי ששינוי
 * שנעשה עם סשן גנוב יהיה גלוי גם אם איש לא הסתכל על כרטיס הספק באותו רגע. **כל שינוי מאפס את
 * האימות הטלפוני** — חשבון שאומת ואז הוחלף אינו חשבון מאומת.
 *
 * @param {{storeId?, bankCode?, bankBranch?, bankAccount?, bankHolder?, holderTaxId?, iban?, note?}} details
 */
export async function setSupplierBankAccount(supplierId, details, actor, x = getExecutor()) {
  if (!userCan(actor, 'manage_suppliers') && actor?.role !== 'owner') {
    throw new AuthError('שינוי פרטי בנק של ספק — בעלים בלבד');
  }
  const supplier = await getSupplier(supplierId, x);
  const storeId = Number(details.storeId) || null;
  if (storeId) {
    const st = await x.one('SELECT id FROM stores WHERE id = ?', [storeId]);
    if (!st) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);
  }

  const { value, errors, warnings } = validateBankDetails(details, { supplierName: supplier.name });
  if (errors.length) throw new RuleError('VALIDATION', errors.join(' · '));

  const existing = (await x.many(
    'SELECT * FROM supplier_bank_accounts WHERE supplier_id = ?', [Number(supplierId)],
  )).find((r) => (r.store_id == null ? null : Number(r.store_id)) === storeId) || null;

  const FIELDS = ['bank_code', 'bank_name', 'bank_branch', 'bank_account', 'bank_holder', 'holder_tax_id', 'iban'];
  const changed = FIELDS.some((f) => (existing?.[f] ?? null) !== (value[f] ?? null));
  if (existing && !changed) return existing;

  const now = nowTs();
  if (existing) {
    await x.run(
      `UPDATE supplier_bank_accounts
          SET bank_code = ?, bank_name = ?, bank_branch = ?, bank_account = ?, bank_holder = ?,
              holder_tax_id = ?, iban = ?, updated_at = ?, updated_by = ?,
              verified_at = NULL, verified_by = NULL, verified_note = NULL
        WHERE id = ?`,
      [value.bank_code, value.bank_name, value.bank_branch, value.bank_account, value.bank_holder,
        value.holder_tax_id, value.iban, now, actor?.id ?? null, existing.id],
    );
  } else {
    await x.run(
      `INSERT INTO supplier_bank_accounts
         (supplier_id, store_id, bank_code, bank_name, bank_branch, bank_account, bank_holder,
          holder_tax_id, iban, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(supplierId), storeId, value.bank_code, value.bank_name, value.bank_branch,
        value.bank_account, value.bank_holder, value.holder_tax_id, value.iban, now, actor?.id ?? null],
    );
  }

  await x.run(
    `INSERT INTO supplier_bank_changes
       (supplier_id, store_id, old_bank, old_branch, old_account, old_holder,
        new_bank, new_branch, new_account, new_holder, old_extra, new_extra, changed_at, changed_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(supplierId), storeId,
      existing?.bank_name ?? null, existing?.bank_branch ?? null, existing?.bank_account ?? null, existing?.bank_holder ?? null,
      value.bank_name, value.bank_branch, value.bank_account, value.bank_holder,
      extraJson(existing), extraJson(value),
      now, actor?.id ?? null, (details.note ?? '').toString().trim() || null,
    ],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'supplier.bank_change', entityType: 'supplier', entityId: Number(supplierId),
      details: { storeId, from: existing?.bank_account ?? null, to: value.bank_account } },
    x,
  );

  const where = storeId ? ` (חנות ${storeId})` : '';
  const { notify } = await import('../lib/notify.js');
  notify(
    existing
      ? `⚠️ פרטי הבנק של ספק שונו\n${supplier.name}${where}\nמ: ${existing.bank_account || '—'} · ל: ${value.bank_account || '—'}\nאם לא ביקשת את השינוי — בדוק מיד מול הספק בטלפון, לא במייל.`
      : `🏦 נקבעו פרטי בנק לספק\n${supplier.name}${where}\nחשבון: ${value.bank_account || '—'} · ${value.bank_name || ''} ${value.bank_branch || ''}`,
    { kind: 'supplier_bank', link: `/suppliers/${supplierId}/edit` },
  );

  const saved = await x.one('SELECT * FROM supplier_bank_accounts WHERE supplier_id = ? AND id = ?',
    [Number(supplierId), existing ? existing.id : (await x.one(
      'SELECT MAX(id) AS id FROM supplier_bank_accounts WHERE supplier_id = ?', [Number(supplierId)]))?.id]);
  return { ...saved, warnings };
}

/**
 * "אומת טלפונית" — הבעלים מאשר שדיבר עם הספק ווידא את החשבון.
 *
 * זה לא קישוט: ההגנה היחידה מפני מייל שמודיע על החלפת חשבון היא שיחה למספר שכבר היה לך, ולכן
 * מי אימת ומתי צריכים להיות רשומים ולא בזיכרון. כל שינוי בפרטים מאפס את החותמת.
 */
export async function verifySupplierBankAccount(accountId, note, actor, x = getExecutor()) {
  if (actor?.role !== 'owner') throw new AuthError('אימות חשבון בנק — בעלים בלבד');
  const row = await x.one('SELECT * FROM supplier_bank_accounts WHERE id = ?', [Number(accountId)]);
  if (!row) throw new NotFoundError('חשבון הבנק לא נמצא');
  await x.run(
    'UPDATE supplier_bank_accounts SET verified_at = ?, verified_by = ?, verified_note = ? WHERE id = ?',
    [nowTs(), actor?.id ?? null, (note ?? '').toString().trim() || null, Number(accountId)],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'supplier.bank_verify', entityType: 'supplier', entityId: Number(row.supplier_id),
      details: { accountId: Number(accountId) } },
    x,
  );
  return x.one('SELECT * FROM supplier_bank_accounts WHERE id = ?', [Number(accountId)]);
}

/** מחיקת חשבון. מתועדת בהיסטוריה כמו כל שינוי — חשבון שנעלם הוא שינוי יעד לכל דבר. */
export async function deleteSupplierBankAccount(accountId, actor, x = getExecutor()) {
  if (actor?.role !== 'owner') throw new AuthError('מחיקת חשבון בנק — בעלים בלבד');
  const row = await x.one('SELECT * FROM supplier_bank_accounts WHERE id = ?', [Number(accountId)]);
  if (!row) throw new NotFoundError('חשבון הבנק לא נמצא');
  await x.run('DELETE FROM supplier_bank_accounts WHERE id = ?', [Number(accountId)]);
  await x.run(
    `INSERT INTO supplier_bank_changes
       (supplier_id, store_id, old_bank, old_branch, old_account, old_holder, old_extra, new_extra, changed_at, changed_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.supplier_id, row.store_id, row.bank_name, row.bank_branch, row.bank_account, row.bank_holder,
      extraJson(row), extraJson(null), nowTs(), actor?.id ?? null, 'החשבון נמחק'],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'supplier.bank_delete', entityType: 'supplier', entityId: Number(row.supplier_id),
      details: { accountId: Number(accountId) } },
    x,
  );
}

/** The change history for one supplier, newest first — what the card shows under the details. */
export async function supplierBankHistory(id, x = getExecutor()) {
  try {
    return await x.many(
      `SELECT c.*, u.name AS changed_by_name, st.name AS store_name
         FROM supplier_bank_changes c
         LEFT JOIN users u ON u.id = c.changed_by
         LEFT JOIN stores st ON st.id = c.store_id
        WHERE c.supplier_id = ?
        ORDER BY c.changed_at DESC, c.id DESC`,
      [id],
    );
  } catch {
    return []; // pre-upgrade database
  }
}

/**
 * האם היעד השתנה בתוך חלון האזהרה? מקבל שורת חשבון (supplier_bank_accounts). `bank_updated_at`
 * נתמך כדי שרשומה במבנה הישן, שעדיין מגיעה ממסד לפני העדכון, לא תיפול בשקט.
 */
export function bankChangedRecently(account, days = BANK_CHANGE_WARN_DAYS, now = new Date()) {
  const stamp = account?.updated_at ?? account?.bank_updated_at;
  if (!stamp) return false;
  const when = new Date(String(stamp).replace(' ', 'T') + 'Z');
  if (Number.isNaN(when.getTime())) return false;
  return (now.getTime() - when.getTime()) / 86400000 <= days;
}
