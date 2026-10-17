// The Telegram bot as a two-way channel: approval requests go out with inline buttons
// ("✓ אשר" / "✕ דחה"), and the owner's tap comes back to POST /ingest/telegram as a webhook.
//
// Trust model — every tap that reaches the app must clear two independent gates:
//   1. the request carries X-Telegram-Bot-Api-Secret-Token = webhookSecret(). Telegram sends it
//      only because setWebhook was told to; the value is derived from the bot token, so it needs
//      no extra env var and changes by itself when the token is rotated;
//   2. callback_query.from.id is the owner's Telegram id (config.telegram.chatId). A forwarded
//      message or a group chat cannot make anyone else's tap count.
// Nothing here throws into the request path; callers get {ok, ...} back.

import { createHmac } from 'node:crypto';
import { config } from '../config.js';

const TG_API = 'https://api.telegram.org';

/** Webhook secret_token: HMAC of the bot token (Telegram allows [A-Za-z0-9_-], 1-256 chars). */
export function webhookSecret() {
  const token = config.telegram.botToken;
  if (!token) return null;
  return createHmac('sha256', token).update('ap-control:telegram-webhook').digest('hex');
}

/** One Bot API call. Never rejects: resolves to {ok, result?, description?}. */
export async function tgCall(method, body) {
  const token = config.telegram.botToken;
  if (!token) return { ok: false, description: 'no TELEGRAM_BOT_TOKEN' };
  try {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (json && json.ok) return { ok: true, result: json.result };
    return { ok: false, description: (json && json.description) || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

/** The app's public origin for links inside a Telegram message, or null when unknown. */
export function publicOrigin() {
  if (config.mail.appUrl) return config.mail.appUrl.replace(/\/$/, '');
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : null;
}

/** callback_data for an approval tap: `cr:a:<id>` approves, `cr:r:<id>` rejects. */
export function parseApprovalData(data) {
  const m = /^cr:([ar]):(\d+)$/.exec(String(data || ''));
  return m ? { decision: m[1] === 'a' ? 'approve' : 'reject', requestId: Number(m[2]) } : null;
}

/** Inline keyboard sent with a new change request. Telegram lays a row out left-to-right even in a
 *  Hebrew chat, so "✕ דחה" comes first to put "✓ אשר" on the RIGHT (בעלים, 17/10). */
export function approvalKeyboard(requestId) {
  const rows = [[
    { text: '✕ דחה', callback_data: `cr:r:${requestId}` },
    { text: '✓ אשר', callback_data: `cr:a:${requestId}` },
  ]];
  const base = publicOrigin();
  if (base) rows.push([{ text: '🔎 פרטים במערכת', url: `${base}/approvals?req=${requestId}` }]);
  return { inline_keyboard: rows };
}

/** The sample sent by "בדוק טלגרם": real-looking buttons whose tap only proves the round trip works. */
export function testKeyboard() {
  return { inline_keyboard: [[
    { text: '✕ דחה', callback_data: 'cr:test' },
    { text: '✓ אשר', callback_data: 'cr:test' },
  ]] };
}

/** What the buttons turn into once the request is decided — a single inert status button. */
export function decidedKeyboard(label) {
  return { inline_keyboard: [[{ text: label, callback_data: 'cr:done' }]] };
}

/**
 * Point the bot's webhook at `${origin}/ingest/telegram` (owner's "חבר כפתורי אישור" button).
 * Only callback_query updates are requested — a typed message to the bot is never delivered.
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function registerWebhook(origin) {
  if (!config.telegram.botToken) {
    return { ok: false, detail: 'לא הוגדר TELEGRAM_BOT_TOKEN במשתני הסביבה של השרת — אין בוט לחבר.' };
  }
  const url = `${String(origin).replace(/\/$/, '')}/ingest/telegram`;
  if (!/^https:\/\//.test(url)) {
    return { ok: false, detail: `טלגרם מקבל רק כתובת https, והכתובת כאן היא ${url}. לחץ על הכפתור מתוך האתר החי.` };
  }
  const set = await tgCall('setWebhook', {
    url, secret_token: webhookSecret(), allowed_updates: ['callback_query'], drop_pending_updates: true,
  });
  if (!set.ok) return { ok: false, detail: `טלגרם סירב לחבר את הכפתורים: ${set.description}` };
  return { ok: true, detail: `כפתורי האישור בטלגרם חוברו (${url}). מעכשיו כל בקשת אישור תגיע עם "✓ אשר" / "✕ דחה".` };
}
