// Telegram push notifications for Z-close alerts (§ 2d).
//
// Uses a DEDICATED bot (separate from any other interface the owner runs). The bot token is
// read from env only (config.telegram); with no token every call is a silent no-op, so the
// app behaves identically before the bot is set up. Failures never throw into the request
// path — alerts are best-effort and fire-and-forget.

import { config } from '../config.js';

const TG_API = 'https://api.telegram.org';

/** True when a bot token + chat id are configured (env). */
export function telegramConfigured() {
  return Boolean(config.telegram.botToken && config.telegram.chatId);
}

/**
 * Send a Telegram message and report exactly what happened — for the owner's "בדוק טלגרם" test,
 * so a silent no-op becomes a visible reason. Never rejects.
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function sendTelegramDetailed(text) {
  const { botToken, chatId } = config.telegram;
  if (!botToken) return { ok: false, detail: 'לא הוגדר TELEGRAM_BOT_TOKEN במשתני הסביבה של השרת (Vercel → Settings → Environment Variables). לאחר הוספה — צריך Redeploy.' };
  if (!chatId) return { ok: false, detail: 'לא הוגדר TELEGRAM_CHAT_ID.' };
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (res.ok && body && body.ok) return { ok: true, detail: `נשלחה הודעת בדיקה ל-chat ${chatId}. בדוק את הטלגרם.` };
    // Telegram returns a human description + error code. Map the common ones to the ACTUAL fix,
    // so the owner isn't sent chasing the wrong thing:
    //   401 Unauthorized  → the bot token is wrong/revoked (NOT a chat problem).
    //   403 Forbidden     → the chat blocked the bot / never pressed Start.
    //   400 chat not found → the chat_id is wrong.
    const why = body && body.description ? body.description : `HTTP ${res.status}`;
    const code = res.status;
    let fix;
    if (code === 401 || code === 404 || /unauthorized|not found/i.test(why)) {
      fix = `הטוקן (TELEGRAM_BOT_TOKEN) שגוי/מעוות. העתק את הטוקן המלא מ-@BotFather בדיוק (בפורמט 123456789:AA... , בלי רווחים, מרכאות או שורה חדשה) לתוך TELEGRAM_BOT_TOKEN ב-Vercel, ואז Redeploy. (השגיאה הזו אינה קשורה ל-chat_id.)`;
    } else if (/can't send messages to the bot|bots can't|to the bot/i.test(why)) {
      fix = `ה-chat_id (${chatId}) הוא של בוט, לא המזהה האישי שלך. השג את המזהה שלך מ-@userinfobot בטלגרם, עדכן את TELEGRAM_CHAT_ID ב-Vercel, ואז Redeploy.`;
    } else if (code === 403 || /blocked|can't initiate|bot can/i.test(why)) {
      fix = `פתח צ׳אט עם הבוט ולחץ Start (בוט לא יכול לשלוח למי שלא פתח איתו שיחה), וודא שה-chat_id (${chatId}) הוא שלך.`;
    } else if (/chat not found/i.test(why)) {
      fix = `ה-chat_id (${chatId}) שגוי. השג את ה-id שלך (שלח הודעה ל-@userinfobot) ועדכן TELEGRAM_CHAT_ID ב-Vercel, ואז Redeploy.`;
    } else {
      fix = `ודא שהטוקן וה-chat_id (${chatId}) נכונים.`;
    }
    return { ok: false, detail: `Telegram סירב: ${why}. ${fix}` };
  } catch (err) {
    return { ok: false, detail: `שגיאת רשת אל Telegram: ${err.message}` };
  }
}

/**
 * Send a Telegram message to the configured chat. Resolves to true if sent, false if skipped
 * (no token) or failed. Never rejects.
 * @param {string} text  message body (HTML parse mode — links allowed)
 */
export async function sendTelegram(text) {
  const r = await sendTelegramDetailed(text);
  // eslint-disable-next-line no-console
  if (!r.ok && config.telegram.botToken) console.error(`[notify] ${r.detail}`);
  return r.ok;
}

/** Strip the small HTML we use in alerts (<b>, links, <br>) down to plain text. */
function toPlain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>(\n)?/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

/**
 * Fire-and-forget wrapper: push a Telegram alert AND record it to the in-app notification stream,
 * without blocking the caller. Both paths are best-effort and never throw. `opts.link` (optional)
 * makes the in-app notification clickable; `opts.kind` tags it.
 * @param {string} text  HTML message body
 * @param {{kind?:string, link?:string}} [opts]
 */
export function notify(text, opts = {}) {
  void sendTelegram(text); // Telegram (no-op if unconfigured); never rejects
  // In-app copy: first line → title, remainder → body. Dynamic import keeps this lib free of a
  // static dependency on the service/DB layer (and avoids any import cycle).
  (async () => {
    try {
      const plain = toPlain(text);
      if (!plain) return;
      const [title, ...rest] = plain.split('\n');
      const { recordNotification } = await import('../services/notifications.js');
      await recordNotification({ kind: opts.kind || 'alert', title, body: rest.join('\n').trim() || null, link: opts.link || null });
    } catch { /* best-effort */ }
  })();
}
