import { getExecutor, nowTs, tx } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { notify } from '../lib/notify.js';
import { logAction } from './audit.js';
import { updateInvoice, approveInvoiceForPayment, releaseHold } from './invoices.js';
import { updateSupplier } from './suppliers.js';
import { editTransaction } from './bankTransactions.js';

// Approval workflow. A non-owner's edit is stored as a pending change_request with a
// human-readable summary; the owner approves (applying it with owner authority) or rejects.
// Applying dispatches through ACTIONS so the real service does the work and enforces its rules.

const ACTIONS = {
  'invoice.update': {
    label: 'עריכת חשבונית',
    apply: (payload, actor, x) => updateInvoice(payload.id, payload.fields, actor, x),
  },
  'invoice.approve_payment': {
    label: 'אישור תשלום לחשבונית',
    apply: (payload, actor, x) => approveInvoiceForPayment(payload.id, actor, x),
  },
  'invoice.release_hold': {
    label: 'שחרור החזקת חשבונית',
    apply: (payload, actor, x) => releaseHold(payload.id, actor, x),
  },
  'supplier.update': {
    label: 'עריכת ספק',
    apply: (payload, actor, x) => updateSupplier(payload.id, payload.fields, actor, x),
  },
  'bank_txn.edit': {
    label: 'עריכת תנועת בנק',
    apply: (payload, actor, x) => editTransaction(payload.id, payload.fields, actor, x),
  },
};

export function actionLabel(action) {
  return ACTIONS[action]?.label || action;
}

/** Queue an edit for approval. Returns the new request id. */
export async function submitRequest({ action, entityType, entityId, payload, summary }, actor, x = getExecutor()) {
  if (!ACTIONS[action]) throw new RuleError('VALIDATION', `פעולה לא נתמכת לאישור: ${action}`);
  const info = await x.run(
    `INSERT INTO change_requests
       (requested_by, requested_by_name, action, entity_type, entity_id, payload, summary, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [actor?.id ?? null, actor?.name ?? null, action, entityType ?? null, entityId ?? null, JSON.stringify(payload), summary ?? null, nowTs()],
  );
  await logAction({ userId: actor?.id ?? null, action: 'change_request.submit', entityType: 'change_request', entityId: info.lastInsertRowid, details: { action } }, x);
  // Generic alert only — no amounts/names/diff (details stay inside the app under /approvals).
  notify(`📝 <b>בקשת אישור עריכה חדשה</b>\nמאת ${actor?.name || 'משתמש'} · ${actionLabel(action)}\nהיכנס למערכת לצפייה ואישור.`);
  return info.lastInsertRowid;
}

export async function listRequests({ status = 'pending' } = {}, x = getExecutor()) {
  if (status) return x.many('SELECT * FROM change_requests WHERE status = ? ORDER BY id DESC', [status]);
  return x.many('SELECT * FROM change_requests ORDER BY id DESC', []);
}

export async function countPending(x = getExecutor()) {
  try {
    const r = await x.one("SELECT COUNT(*) AS n FROM change_requests WHERE status = 'pending'", []);
    return Number(r?.n || 0);
  } catch {
    return 0; // table may not exist pre-upgrade
  }
}

/** The most recent pending request of a given action for an entity, or null. */
export async function pendingRequestFor(entityType, entityId, action, x = getExecutor()) {
  try {
    return await x.one(
      "SELECT * FROM change_requests WHERE status = 'pending' AND entity_type = ? AND entity_id = ? AND action = ? ORDER BY id DESC",
      [entityType, entityId, action],
    );
  } catch {
    return null; // table may not exist pre-upgrade
  }
}

export async function getRequest(id, x = getExecutor()) {
  const r = await x.one('SELECT * FROM change_requests WHERE id = ?', [id]);
  if (!r) throw new NotFoundError(`בקשה ${id} לא נמצאה`);
  return r;
}

/**
 * Approve a request: apply it with the owner's authority AND mark it approved in a single DB
 * transaction, so a failure anywhere rolls back both — the change is never applied while the
 * request stays "pending" (which would allow a second approval = double-apply). The status is
 * re-checked inside the transaction to close the race. The Telegram alert fires only after the
 * commit and is fire-and-forget, so a notification failure can never undo an applied approval.
 */
export async function approveRequest(id, ownerActor, x = getExecutor()) {
  const req = await getRequest(id, x);
  if (req.status !== 'pending') throw new RuleError('STATE', 'הבקשה כבר טופלה');
  const spec = ACTIONS[req.action];
  if (!spec) throw new RuleError('VALIDATION', `פעולה לא נתמכת: ${req.action}`);

  const payload = JSON.parse(req.payload);
  const result = `אושר ובוצע: ${actionLabel(req.action)} — ${req.summary || ''}`;

  await tx(async (t) => {
    // Re-check status inside the transaction to prevent a concurrent double-approve.
    const fresh = await t.one('SELECT status FROM change_requests WHERE id = ?', [id]);
    if (!fresh || fresh.status !== 'pending') throw new RuleError('STATE', 'הבקשה כבר טופלה');
    await spec.apply(payload, ownerActor, t); // real service enforces its own rules, on the same txn
    await t.run(
      "UPDATE change_requests SET status = 'approved', decided_by = ?, decided_at = ?, result_summary = ? WHERE id = ?",
      [ownerActor?.id ?? null, nowTs(), result, id],
    );
    await logAction({ userId: ownerActor?.id ?? null, action: 'change_request.approve', entityType: 'change_request', entityId: id, details: { action: req.action } }, t);
  });

  notify(`✅ <b>בקשת עריכה אושרה ובוצעה</b>\n${actionLabel(req.action)} (בקשת ${req.requested_by_name || ''}). הפרטים במערכת.`);
  return getRequest(id, x);
}

export async function rejectRequest(id, ownerActor, note = null, x = getExecutor()) {
  const req = await getRequest(id, x);
  if (req.status !== 'pending') throw new RuleError('STATE', 'הבקשה כבר טופלה');
  await x.run(
    "UPDATE change_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?",
    [ownerActor?.id ?? null, nowTs(), note, id],
  );
  await logAction({ userId: ownerActor?.id ?? null, action: 'change_request.reject', entityType: 'change_request', entityId: id, details: { note } }, x);
  notify(`⛔ <b>בקשת עריכה נדחתה</b>\n${actionLabel(req.action)} (בקשת ${req.requested_by_name || ''})${note ? '\nסיבה: ' + note : ''}`);
  return getRequest(id, x);
}
