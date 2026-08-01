import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import {
  createTransfer,
  approveTransferProof,
  executeTransfer,
  cancelTransfer,
  setTransferReference,
  getTransfer,
  transfersSummary,
} from '../src/services/transfers.js';

async function anAccount(db) {
  const store = await firstStore(db);
  return accountForStore(db, store.id);
}

test('createTransfer stores agorot, defaults to scheduled/unapproved', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await anAccount(db);
  const t = await createTransfer(
    { bankAccountId: acct.id, payee: 'חברת החשמל', amount: '2,180.50', transferDate: '2026-08-05', reference: 'REF-1', recurrence: 'monthly' },
    o,
    db,
  );
  assert.equal(t.amount, 218050);
  assert.equal(t.status, 'scheduled');
  assert.equal(t.proof_approved, 0);
  assert.equal(t.recurrence, 'monthly');
  assert.equal(t.match_type, 'pending');
});

test('createTransfer rejects zero/negative amount and empty payee', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await anAccount(db);
  await assert.rejects(
    () => createTransfer({ bankAccountId: acct.id, payee: '', amount: '100', transferDate: '2026-08-05' }, o, db),
    /מקבל/,
  );
  await assert.rejects(
    () => createTransfer({ bankAccountId: acct.id, payee: 'x', amount: '0', transferDate: '2026-08-05' }, o, db),
    /חיובי/,
  );
});

test('execute is blocked until the owner approves the proof', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const sec = await secretary(db);
  const acct = await anAccount(db);
  const t = await createTransfer(
    { bankAccountId: acct.id, payee: 'ספק', amount: '500', transferDate: '2026-08-05', reference: 'A1' },
    sec,
    db,
  );
  // Secretary cannot approve.
  await assert.rejects(() => approveTransferProof(t.id, sec, db), /בעלים/);
  // Cannot execute before approval.
  await assert.rejects(() => executeTransfer(t.id, sec, db), /אושרה/);
  // Owner approves, then execute succeeds.
  await approveTransferProof(t.id, o, db);
  const done = await executeTransfer(t.id, sec, db);
  assert.equal(done.status, 'executed');
  assert.ok(done.executed_at);
});

test('cannot approve a transfer that has no reference', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await anAccount(db);
  const t = await createTransfer({ bankAccountId: acct.id, payee: 'ספק', amount: '500', transferDate: '2026-08-05' }, o, db);
  await assert.rejects(() => approveTransferProof(t.id, o, db), /אסמכתא/);
  // adding a reference resets approval and then allows it
  await setTransferReference(t.id, 'REF-9', o, db);
  const approved = await approveTransferProof(t.id, o, db);
  assert.equal(approved.proof_approved, 1);
});

test('setTransferReference resets a prior approval', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await anAccount(db);
  const t = await createTransfer({ bankAccountId: acct.id, payee: 'ספק', amount: '500', transferDate: '2026-08-05', reference: 'R1' }, o, db);
  await approveTransferProof(t.id, o, db);
  const changed = await setTransferReference(t.id, 'R2', o, db);
  assert.equal(changed.proof_approved, 0);
  assert.equal(changed.reference, 'R2');
});

test('cancel is owner-only and records a reason', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const sec = await secretary(db);
  const acct = await anAccount(db);
  const t = await createTransfer({ bankAccountId: acct.id, payee: 'ספק', amount: '500', transferDate: '2026-08-05', reference: 'R1' }, o, db);
  await assert.rejects(() => cancelTransfer(t.id, sec, 'טעות', db), /בעלים/);
  const cancelled = await cancelTransfer(t.id, o, 'שולם אחרת', db);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancel_reason, 'שולם אחרת');
  // A cancelled transfer cannot be executed.
  await assert.rejects(() => executeTransfer(t.id, o, db), /מבוטלת/);
});

test('transfersSummary counts scheduled, awaiting approval, and unmatched', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await anAccount(db);
  await createTransfer({ bankAccountId: acct.id, payee: 'a', amount: '100', transferDate: '2026-08-01', reference: 'R1' }, o, db);
  await createTransfer({ bankAccountId: acct.id, payee: 'b', amount: '200', transferDate: '2026-08-02', matchType: 'none' }, o, db);
  const s = await transfersSummary(db);
  assert.equal(s.scheduledCount, 2);
  assert.equal(s.scheduledTotal, 30000);
  assert.equal(s.awaitingApproval, 2); // neither approved yet
  assert.equal(s.unmatched, 2); // neither matched to an invoice
});

test('getTransfer throws for a missing id', async () => {
  const db = await freshDb();
  await assert.rejects(() => getTransfer(99999, db), /לא נמצאה/);
});
