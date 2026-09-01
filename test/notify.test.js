import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { sendTelegram, sendTelegramDetailed, telegramConfigured } from '../src/lib/notify.js';

test('sendTelegram is a no-op when no bot token is configured', async () => {
  const saved = config.telegram.botToken;
  config.telegram.botToken = null;
  try {
    assert.equal(await sendTelegram('hello'), false);
  } finally {
    config.telegram.botToken = saved;
  }
});

test('sendTelegram posts to the Telegram API when configured', async () => {
  const savedToken = config.telegram.botToken;
  const savedFetch = global.fetch;
  const calls = [];
  config.telegram.botToken = 'TEST:token';
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    const ok = await sendTelegram('שלום');
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/botTEST:token\/sendMessage$/);
    assert.equal(calls[0].body.chat_id, config.telegram.chatId);
    assert.equal(calls[0].body.text, 'שלום');
    assert.equal(calls[0].body.parse_mode, 'HTML');
  } finally {
    config.telegram.botToken = savedToken;
    global.fetch = savedFetch;
  }
});

test('sendTelegram returns false (no throw) on network error', async () => {
  const savedToken = config.telegram.botToken;
  const savedFetch = global.fetch;
  config.telegram.botToken = 'TEST:token';
  global.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await sendTelegram('x'), false);
  } finally {
    config.telegram.botToken = savedToken;
    global.fetch = savedFetch;
  }
});

test('sendTelegramDetailed explains why nothing was sent (the "בדוק טלגרם" diagnostic)', async () => {
  const savedToken = config.telegram.botToken;
  const savedFetch = global.fetch;
  try {
    // No token → a clear reason (points at the env var), not a silent false.
    config.telegram.botToken = null;
    assert.equal(telegramConfigured(), false);
    const noTok = await sendTelegramDetailed('x');
    assert.equal(noTok.ok, false);
    assert.match(noTok.detail, /TELEGRAM_BOT_TOKEN/);

    // Token set but Telegram rejects (e.g. user never pressed Start) → surfaces the description.
    config.telegram.botToken = 'TEST:token';
    global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) });
    const rej = await sendTelegramDetailed('x');
    assert.equal(rej.ok, false);
    assert.match(rej.detail, /blocked by the user/);

    // Happy path → ok.
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: {} }) });
    const good = await sendTelegramDetailed('x');
    assert.equal(good.ok, true);
  } finally {
    config.telegram.botToken = savedToken;
    global.fetch = savedFetch;
  }
});
