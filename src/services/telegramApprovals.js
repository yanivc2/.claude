// The owner's tap on "✓ אשר" / "✕ דחה" under a Telegram approval request (see lib/telegramBot.js).
// The decision runs through the very same approveRequest/rejectRequest the /approvals page uses —
// same transaction, same re-check, same audit — so Telegram is only another place to press it.

import { getExecutor } from '../db/adapter.js';
import { config } from '../config.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { tgCall, parseApprovalData, decidedKeyboard } from '../lib/telegramBot.js';
import { approveRequest, rejectRequest } from './changeRequests.js';
import { logAction } from './audit.js';

const STATUS_LABEL = { approved: '✅ אושר', rejected: '⛔ נדחה' };

/** The user a Telegram decision is recorded as: the first owner (the bot pushes to the owner only). */
async function ownerActor(x) {
  return x.one("SELECT id, name, role FROM users WHERE role = 'owner' ORDER BY id LIMIT 1", []);
}

/** Toast on the owner's phone + (optionally) swap the buttons for a status line. Best-effort. */
async function reply(cq, toast, statusLabel, alert = false) {
  await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: toast, show_alert: alert });
  const msg = cq.message;
  if (statusLabel && msg && msg.chat) {
    await tgCall('editMessageReplyMarkup', {
      chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: decidedKeyboard(statusLabel),
    });
  }
}

/**
 * Handle one webhook update. Returns what happened (for tests/logs); never throws for a bad tap.
 * @returns {Promise<{handled:boolean, outcome?:string}>}
 */
export async function handleTelegramUpdate(update, x = getExecutor()) {
  const cq = update && update.callback_query;
  if (!cq || !cq.id) return { handled: false };

  // Gate 2 (gate 1 = the webhook secret, checked by the route): only the owner's own tap counts.
  if (String(cq.from && cq.from.id) !== String(config.telegram.chatId)) {
    await reply(cq, 'אין לך הרשאה לאשר בקשות.', null, true);
    return { handled: true, outcome: 'forbidden' };
  }
  if (cq.data === 'cr:test') {
    // The sample from "בדוק טלגרם": reaching here means Telegram → webhook → app works end to end.
    await reply(cq, '✅ הכפתורים עובדים — החיבור תקין', '✅ הכפתורים עובדים');
    return { handled: true, outcome: 'test_ok' };
  }
  if (cq.data === 'cr:done') {
    await reply(cq, 'הבקשה כבר טופלה.', null);
    return { handled: true, outcome: 'noop' };
  }
  const parsed = parseApprovalData(cq.data);
  if (!parsed) {
    await reply(cq, 'כפתור לא מוכר.', null);
    return { handled: true, outcome: 'unknown' };
  }

  const owner = await ownerActor(x);
  if (!owner) {
    await reply(cq, 'לא נמצא משתמש בעלים במערכת.', null, true);
    return { handled: true, outcome: 'no_owner' };
  }

  const { decision, requestId } = parsed;
  try {
    if (decision === 'approve') await approveRequest(requestId, owner, x);
    else await rejectRequest(requestId, owner, null, x);
    await logAction({ userId: owner.id, action: 'change_request.telegram', entityType: 'change_request', entityId: requestId, details: { decision } }, x);
    const label = decision === 'approve' ? STATUS_LABEL.approved : STATUS_LABEL.rejected;
    await reply(cq, decision === 'approve' ? '✅ אושר' : '⛔ נדחה — הפעולה בוטלה', label);
    return { handled: true, outcome: decision === 'approve' ? 'approved' : 'rejected' };
  } catch (err) {
    if (err instanceof NotFoundError) {
      await reply(cq, 'הבקשה לא נמצאה במערכת.', '— הבקשה לא קיימת');
      return { handled: true, outcome: 'not_found' };
    }
    if (err instanceof RuleError && err.rule === 'STATE') {
      // Decided elsewhere (the app, or a second tap) — show what it ended as.
      const row = await x.one('SELECT status FROM change_requests WHERE id = ?', [requestId]);
      await reply(cq, 'הבקשה כבר טופלה.', STATUS_LABEL[row?.status] || '✔ טופל');
      return { handled: true, outcome: 'already' };
    }
    await reply(cq, `לא בוצע: ${err.message}`.slice(0, 190), null, true);
    return { handled: true, outcome: 'error' };
  }
}
