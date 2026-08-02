import webpush from "web-push";
import { prisma } from "./prisma";

// ─────────────────────────────────────────────────────────────────────────
// שליחת Web Push. המפתחות (VAPID) נטענים ממשתני סביבה — אין לשמור מפתח פרטי
// בקוד. אם המפתחות חסרים, השליחה מדולגת בשקט (ההתראה עדיין נשמרת ב-DB
// ותוצג במרכז ההתראות בתוך האפליקציה).
// ─────────────────────────────────────────────────────────────────────────

const PUBLIC = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:hr@example.com";

let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!PUBLIC || !PRIVATE) return false;
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
    configured = true;
    return true;
  } catch {
    return false;
  }
}

export function pushEnabled(): boolean {
  return !!PUBLIC && !!PRIVATE;
}

export interface PushPayload {
  title: string;
  body: string;
  link?: string;
}

// שולח התראת פוש לכל המכשירים הרשומים של משתמש. מנקה מנויים שפגו (410/404).
export async function sendPushToUser(username: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;
  const subs = await prisma.pushSubscription.findMany({ where: { username } });
  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        // מנוי שכבר אינו תקף — מסירים כדי לא לנסות שוב.
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        }
      }
    }),
  );
}
