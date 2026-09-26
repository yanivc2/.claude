// נקודות הקצה של סוכן מחשב המשרד — דרך HTTP אמיתי, כולל חסימות האימות.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { requestSync, submitOtp } from '../src/services/bankSyncJobs.js';

let server, base;
before(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, { secret, body = {}, headers = {} } = {}) =>
  fetch(`${base}/ingest/bank-agent${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-name': 'test-pc',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

test('כבוי בלי סוד, דוחה סוד שגוי', async () => {
  const saved = config.bankAgentSecret;
  await freshDb();
  try {
    config.bankAgentSecret = null;
    assert.equal((await post('/claim')).status, 503, 'אף פעם לא פתוח בטעות');
    config.bankAgentSecret = 'agent-s3cret';
    assert.equal((await post('/claim', { secret: 'nope' })).status, 401);
    assert.equal((await post('/claim', { secret: 'agent-s3cre' })).status, 401, 'אורך שונה');
    assert.equal((await post('/claim', { secret: 'agent-s3cret' })).status, 200);
  } finally {
    config.bankAgentSecret = saved;
  }
});

// 🔴 הסוד לא מתקבל ב-URL: כתובות נרשמות ביומני הגישה, ונקודות הקצה האלה מעבירות קודי SMS.
test('סוד ב-query string אינו מתקבל', async () => {
  const saved = config.bankAgentSecret;
  await freshDb();
  try {
    config.bankAgentSecret = 'agent-s3cret';
    const r = await fetch(`${base}/ingest/bank-agent/claim?key=agent-s3cret`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(r.status, 401);
  } finally {
    config.bankAgentSecret = saved;
  }
});

test('סבב מלא על HTTP: תפיסה → ממתין לקוד → קוד → סיום', async () => {
  const saved = config.bankAgentSecret;
  const db = await freshDb();
  try {
    config.bankAgentSecret = 'agent-s3cret';
    const secret = 'agent-s3cret';
    const o = await owner(db);
    const job = await requestSync(o, db);

    const claim = await (await post('/claim', { secret })).json();
    assert.equal(claim.job.id, job.id);

    await post(`/${job.id}/state`, { secret, body: { status: 'awaiting_otp' } });
    assert.deepEqual((await (await post(`/${job.id}/otp`, { secret })).json()).otp, null);

    await submitOtp(job.id, '654321', o, db);
    const got = await post(`/${job.id}/otp`, { secret });
    assert.equal(got.headers.get('cache-control'), 'no-store', 'קוד חד-פעמי לא במטמון');
    assert.equal((await got.json()).otp, '654321');

    const done = await (await post(`/${job.id}/result`, {
      secret, body: { accounts: [{ accountNumber: '12-999-000111', transactions: [] }] },
    })).json();
    assert.equal(done.ok, true);
    const row = await db.one('SELECT status, otp_code FROM bank_sync_jobs WHERE id = ?', [job.id]);
    assert.equal(row.status, 'done');
    assert.equal(row.otp_code, null);
  } finally {
    config.bankAgentSecret = saved;
  }
});
