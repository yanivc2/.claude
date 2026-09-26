// תור סנכרון הבנק — מכונת המצבים בין האפליקציה לסוכן במחשב המשרד.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary } from './helpers.js';
import {
  requestSync, submitOtp, cancelSync, syncStatus, claimNext, reportState, takeOtp,
  completeWithAccounts, loginKeyFor, normalizeOtp, CLAIM_WINDOW_SEC,
} from '../src/services/bankSyncJobs.js';

test('המסלול המלא: בקשה → תפיסה → ממתין לקוד → קוד → הסוכן לוקח → סיום', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const job = await requestSync(o, x);
  assert.equal(job.status, 'requested');
  assert.equal(job.login_key, loginKeyFor(o), 'מפתח = שם משתמש, לא סיסמה');

  const claimed = await claimNext('office-pc', x);
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.loginKey, loginKeyFor(o));

  await reportState(job.id, { status: 'awaiting_otp' }, 'office-pc', x);
  let st = await syncStatus(o, null, x);
  assert.equal(st.job.status, 'awaiting_otp');
  assert.equal(st.job.canEnterOtp, true);

  assert.deepEqual(await takeOtp(job.id, 'office-pc', x), { otp: null }, 'אין קוד עדיין');
  await submitOtp(job.id, ' 123-456 ', o, x);
  const t = await takeOtp(job.id, 'office-pc', x);
  assert.equal(t.otp, '123456', 'רווחים ומקפים מההעתקה מוסרים');

  // 🔴 הקוד נמחק מהמסד ברגע שנלקח, ולעולם לא נמסר פעמיים.
  const row = await x.one('SELECT otp_code, status FROM bank_sync_jobs WHERE id = ?', [job.id]);
  assert.equal(row.otp_code, null);
  assert.equal(row.status, 'running');
  assert.deepEqual(await takeOtp(job.id, 'office-pc', x), { otp: null });

  const done = await completeWithAccounts(job.id, { accounts: [{ accountNumber: '999999999', transactions: [] }] }, 'office-pc', x);
  assert.equal(done.ok, true);
  st = await syncStatus(o, null, x);
  assert.equal(st.job.status, 'done');
  assert.equal(st.job.result.unmappedCount, 1, 'חשבון לא רשום מדווח, לא מנוחש');
  assert.match(st.job.result.unmapped[0], /^…\d{4}$/, 'מספר לא מזוהה נשמר מוסתר');
});

// שתי התחברויות מקבילות לאותו בנק = מנגנון ההונאה שלו, ושני SMS בבת אחת מבלבלים.
test('בקשה פעילה אחת בכל רגע', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const s = await secretary(x);
  await requestSync(o, x);
  await assert.rejects(() => requestSync(s, x), /כבר מתבצע/);
});

// ה-SMS נשלח לטלפון של מי שלחץ. מזכירה לא יכולה להזין קוד לבקשה של הבעלים ולהפך (חוץ מהבעלים).
test('רק מי שביקש (או הבעלים) מזין את הקוד', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const s = await secretary(x);
  const job = await requestSync(o, x);
  await claimNext('pc', x);
  await reportState(job.id, { status: 'awaiting_otp' }, 'pc', x);
  await assert.rejects(() => submitOtp(job.id, '123456', s, x), /רק מי שהתחיל/);
  await submitOtp(job.id, '123456', o, x);
});

test('קוד שאינו ספרות נדחה', async () => {
  assert.equal(normalizeOtp('12a456'), null);
  assert.equal(normalizeOtp('12'), null);
  assert.equal(normalizeOtp('123456'), '123456');
});

test('קוד לא מתקבל כשהסנכרון אינו ממתין לקוד', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const job = await requestSync(o, x);
  await assert.rejects(() => submitOtp(job.id, '123456', o, x), /לא ממתין לקוד/);
});

// 🔴 המחשב כבוי, מישהו לוחץ והולך. בבוקר המחשב נדלק — אסור שיתפוס את הבקשה הישנה וישלח SMS
// לאדם שלא מצפה לו.
test('בקשה ישנה פוקעת ואינה נתפסת', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const job = await requestSync(o, x);
  const old = new Date(Date.now() - (CLAIM_WINDOW_SEC + 30) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await x.run('UPDATE bank_sync_jobs SET requested_at = ?, updated_at = ? WHERE id = ?', [old, old, job.id]);
  assert.equal(await claimNext('pc', x), null);
  const row = await x.one('SELECT status FROM bank_sync_jobs WHERE id = ?', [job.id]);
  assert.equal(row.status, 'expired');
  // והיא לא חוסמת בקשה חדשה.
  const again = await requestSync(o, x);
  assert.equal(again.status, 'requested');
});

test('ביטול עוצר את הסוכן', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const job = await requestSync(o, x);
  await claimNext('pc', x);
  await cancelSync(job.id, o, x);
  const r = await takeOtp(job.id, 'pc', x);
  assert.equal(r.cancelled, true);
  const st = await reportState(job.id, { status: 'running' }, 'pc', x);
  assert.equal(st.cancelled, true);
});

// שני סוכנים שרצים בטעות על שני מחשבים לא יתחברו לבנק פעמיים.
test('תפיסה אטומית: בקשה נתפסת פעם אחת', async () => {
  const x = await freshDb();
  const o = await owner(x);
  await requestSync(o, x);
  const a = await claimNext('pc-a', x);
  const b = await claimNext('pc-b', x);
  assert.ok(a);
  assert.equal(b, null);
});

test('פעימת החיים מסמנת את מחשב המשרד כמחובר', async () => {
  const x = await freshDb();
  const o = await owner(x);
  assert.equal((await syncStatus(o, null, x)).agentOnline, false);
  await claimNext('office-pc', x);
  assert.equal((await syncStatus(o, null, x)).agentOnline, true);
});

// 🔴 סנכרון אחד מושך את כל החשבונות שפרטי הבנק רואים. משתמשת עם הרשאה לחנות אחת לא תראה
// מספרי חשבון וסכומים של חנות אחרת.
test('תוצאת הסנכרון מסוננת לסקופ של הצופה', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const job = await requestSync(o, x);
  await claimNext('pc', x);
  await x.run(
    `UPDATE bank_sync_jobs SET status = 'done', finished_at = updated_at, result = ? WHERE id = ?`,
    [JSON.stringify({ accounts: [
      { accountId: 1, storeId: 1, displayName: 'א', inserted: 5, matched: 1 },
      { accountId: 2, storeId: 2, displayName: 'ב', inserted: 7, matched: 2 },
    ], unmapped: [] }), job.id],
  );
  const scoped = await syncStatus(o, { companyIds: null, storeIds: [2] }, x);
  assert.deepEqual(scoped.job.result.accounts.map((a) => a.displayName), ['ב']);
  assert.equal(scoped.job.result.inserted, 7);
  const all = await syncStatus(o, null, x);
  assert.equal(all.job.result.accounts.length, 2);
});

// 🔴 בקשות HTTP לא מגיעות בהכרח לפי הסדר. דיווח "עובד…" שהגיע אחרי "ממתין לקוד" היה מעלים את
// שדה הקוד מהמסך בדיוק כשה-SMS מגיע — והקוד פג בזמן שהמשתמש מחפש איפה להקליד אותו.
test('דיווח "עובד" באיחור אינו מעלים את שדה הקוד', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const job = await requestSync(o, x);
  await claimNext('pc', x);
  await reportState(job.id, { status: 'awaiting_otp' }, 'pc', x);
  const r = await reportState(job.id, { status: 'running', message: 'מתחבר…' }, 'pc', x);
  assert.equal(r.ignored, true);
  const row = await x.one('SELECT status FROM bank_sync_jobs WHERE id = ?', [job.id]);
  assert.equal(row.status, 'awaiting_otp', 'עדיין ממתין לקוד');
  // ורק לקיחת הקוד מוציאה אותו מהמצב הזה.
  await submitOtp(job.id, '111222', o, x);
  await takeOtp(job.id, 'pc', x);
  assert.equal((await x.one('SELECT status FROM bank_sync_jobs WHERE id = ?', [job.id])).status, 'running');
});
