// בעלים, 16/10: "לקבל הודעה ולאשר את הבקשה משם, וזה יתקבל בתוכנה" — טלגרם קודם (וואטסאפ אחרי אישור).
// בקשת אישור יוצאת עם "✓ אשר / ✕ דחה"; הלחיצה מגיעה ל-POST /ingest/telegram, עוברת שני שערים (סוד ה-webhook
// + שהלוחץ הוא הבעלים), ומריצה את אותו approveRequest/rejectRequest של דף האישורים.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { config } from '../src/config.js';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setCashExpenseSettled, unmatchedCashExpenses } from '../src/services/zreports.js';
import { listRequests } from '../src/services/changeRequests.js';
import { webhookSecret, parseApprovalData } from '../src/lib/telegramBot.js';

const OWNER_TG = '5550001';
let db, o, sec, st, server, base, realFetch, tg;
const savedTg = { ...config.telegram };

before(async () => {
  db = await freshDb();
  o = await owner(db);
  sec = await secretary(db);
  st = await firstStore(db);
  config.telegram.botToken = 'TEST:token';
  config.telegram.chatId = OWNER_TG;
  realFetch = global.fetch;
  tg = [];
  // Telegram is mocked; everything else (the app under test) goes to the real fetch.
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) {
      tg.push({ method: u.split('/').pop(), body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 77 } }) };
    }
    return realFetch(url, opts);
  };
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server && server.close();
  global.fetch = realFetch;
  Object.assign(config.telegram, savedTg);
});

const anExpense = async (purpose) => {
  const zc = await db.run("INSERT INTO z_closings (employee_first, employee_last, store_id, z_number) VALUES ('רון','לוי',?,'5501')", [st.id]);
  return Number((await db.run(
    "INSERT INTO z_closing_expenses (closing_id, expense_date, payer_name, purpose, description_type, amount) VALUES (?, '2026-10-15', 'נהג', ?, 'manual', 4000)",
    [zc.lastInsertRowid, purpose],
  )).lastInsertRowid);
};
const isOpen = async (id) => (await unmatchedCashExpenses(null, 100, null, db)).some((r) => r.source === 'zclosing' && Number(r.id) === id);
const settleRequest = async (purpose) => {
  const id = await anExpense(purpose);
  await setCashExpenseSettled('zclosing', id, true, sec, null, db);
  const req = (await listRequests({ status: 'pending' }, db)).find((q) => q.action === 'cash_expense.settle' && Number(q.entity_id) === id);
  return { id, req };
};
const tap = (data, fromId = OWNER_TG, secret = webhookSecret()) => fetch(`${base}/ingest/telegram`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
  body: JSON.stringify({ update_id: 1, callback_query: { id: 'cq1', from: { id: Number(fromId) }, data, message: { message_id: 77, chat: { id: Number(OWNER_TG) } } } }),
});
const status = async (id) => (await db.one('SELECT status FROM change_requests WHERE id = ?', [id])).status;

test('a new approval request goes to Telegram with "✓ אשר" / "✕ דחה" buttons', async () => {
  tg.length = 0;
  const { req } = await settleRequest('מונית');
  const msg = tg.find((c) => c.method === 'sendMessage' && /בקשת אישור חדשה/.test(c.body.text));
  assert.ok(msg, 'the alert was sent');
  const [[ok, no]] = msg.body.reply_markup.inline_keyboard;
  assert.equal(ok.text, '✓ אשר');
  assert.equal(ok.callback_data, `cr:a:${req.id}`);
  assert.equal(no.callback_data, `cr:r:${req.id}`);
  assert.deepEqual(parseApprovalData(`cr:r:${req.id}`), { decision: 'reject', requestId: Number(req.id) });
});

test('gate 1: no secret / wrong secret → refused, nothing decided', async () => {
  const { req } = await settleRequest('חשמלאי');
  assert.equal((await tap(`cr:a:${req.id}`, OWNER_TG, null)).status, 401);
  assert.equal((await tap(`cr:a:${req.id}`, OWNER_TG, 'x'.repeat(64))).status, 401);
  assert.equal(await status(req.id), 'pending');
});

test('gate 2: a tap by anyone but the owner is refused (answered, not applied)', async () => {
  const { req } = await settleRequest('מנעולן');
  tg.length = 0;
  const r = await (await tap(`cr:a:${req.id}`, '999')).json();
  assert.equal(r.outcome, 'forbidden');
  assert.equal(await status(req.id), 'pending');
  assert.ok(tg.some((c) => c.method === 'answerCallbackQuery' && /אין לך הרשאה/.test(c.body.text)));
});

test('owner taps "✓ אשר" → approved in the app; the buttons become "✅ אושר"', async () => {
  const { id, req } = await settleRequest('דלק');
  tg.length = 0;
  const r = await (await tap(`cr:a:${req.id}`)).json();
  assert.equal(r.outcome, 'approved');
  assert.equal(await status(req.id), 'approved');
  assert.equal(await isOpen(id), false, 'stays settled');
  const edit = tg.find((c) => c.method === 'editMessageReplyMarkup');
  assert.equal(edit.body.reply_markup.inline_keyboard[0][0].text, '✅ אושר');
  assert.ok(await db.one("SELECT id FROM audit_log WHERE action = 'change_request.telegram' AND entity_id = ?", [req.id]), 'audited as a Telegram decision');
});

test('owner taps "✕ דחה" → rejected and the "טופל" is undone (back on the list)', async () => {
  const { id, req } = await settleRequest('ציוד');
  assert.equal(await isOpen(id), false);
  const r = await (await tap(`cr:r:${req.id}`)).json();
  assert.equal(r.outcome, 'rejected');
  assert.equal(await status(req.id), 'rejected');
  assert.equal(await isOpen(id), true);
});

test('a second tap (or one after deciding in the app) says "already handled" and shows the result', async () => {
  const { req } = await settleRequest('ניקיון');
  await tap(`cr:a:${req.id}`);
  tg.length = 0;
  const r = await (await tap(`cr:r:${req.id}`)).json();
  assert.equal(r.outcome, 'already');
  assert.equal(await status(req.id), 'approved', 'the late reject changed nothing');
  assert.ok(tg.some((c) => c.method === 'answerCallbackQuery' && /כבר טופלה/.test(c.body.text)));
  assert.equal(tg.find((c) => c.method === 'editMessageReplyMarkup').body.reply_markup.inline_keyboard[0][0].text, '✅ אושר');
});

test('"בדוק טלגרם" also connects the buttons: setWebhook → /ingest/telegram with the derived secret', async () => {
  tg.length = 0;
  const r = await fetch(`${base}/settings/telegram-test`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `session=${createSession(o.id)}`, 'x-forwarded-proto': 'https', 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /כפתורי האישור בטלגרם חוברו/);
  const set = tg.find((c) => c.method === 'setWebhook');
  assert.match(set.body.url, /^https:\/\/127\.0\.0\.1:\d+\/ingest\/telegram$/);
  assert.equal(set.body.secret_token, webhookSecret());
  assert.deepEqual(set.body.allowed_updates, ['callback_query']);
});

test('no bot token → the webhook is closed (503)', async () => {
  const saved = config.telegram.botToken;
  config.telegram.botToken = null;
  try {
    assert.equal((await tap('cr:a:1', OWNER_TG, 'anything')).status, 503);
  } finally {
    config.telegram.botToken = saved;
  }
});
