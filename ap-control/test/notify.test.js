import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { sendTelegram } from '../src/lib/notify.js';

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
    return { ok: true };
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
