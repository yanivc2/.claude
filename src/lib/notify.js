// Telegram push notifications for Z-close alerts (§ 2d).
//
// Uses a DEDICATED bot (separate from any other interface the owner runs). The bot token is
// read from env only (config.telegram); with no token every call is a silent no-op, so the
// app behaves identically before the bot is set up. Failures never throw into the request
// path — alerts are best-effort and fire-and-forget.

import { config } from '../config.js';

const TG_API = 'https://api.telegram.org';

/**
 * Send a Telegram message to the configured chat. Resolves to true if sent, false if skipped
 * (no token) or failed. Never rejects.
 * @param {string} text  message body (HTML parse mode — links allowed)
 */
export async function sendTelegram(text) {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return false; // not configured yet → no-op
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[notify] Telegram sendMessage failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[notify] Telegram error: ${err.message}`);
    return false;
  }
}

/**
 * Fire-and-forget wrapper: schedule a Telegram alert without blocking the caller. Safe to call
 * from a request handler — errors are swallowed by sendTelegram.
 * @param {string} text
 */
export function notify(text) {
  // Intentionally not awaited; sendTelegram never rejects.
  void sendTelegram(text);
}
