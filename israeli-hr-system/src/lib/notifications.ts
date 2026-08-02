import type { NotificationType } from "@prisma/client";
import { prisma } from "./prisma";
import { getAdmin } from "./admin";
import { sendPushToUser } from "./push";

// ─────────────────────────────────────────────────────────────────────────
// התראות פנימיות לבעלים + פוש. נוצרות כשמנהל חנות מבצע פעולה הדורשת ידיעה
// או אישור (הנפקת שימוע/פיטורין, העלאת מסמך לאישור).
// ─────────────────────────────────────────────────────────────────────────

interface NewNotification {
  type: NotificationType;
  title: string;
  body: string;
  link?: string;
  actorName?: string;
  companyId?: string | null;
}

// יוצר התראה עבור משתמש נתון (username) ושולח פוש. משמש גם לעובדים (username
// של העובד) וגם למנהלים. לא זורק אם הפוש נכשל.
export async function notifyUser(username: string, n: NewNotification): Promise<void> {
  await prisma.notification.create({
    data: {
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link ?? null,
      forUsername: username,
      actorName: n.actorName ?? null,
      companyId: n.companyId ?? null,
    },
  });
  await sendPushToUser(username, { title: n.title, body: n.body, link: n.link }).catch(() => {});
}

// יוצר התראה עבור הבעלים ושולח פוש (אם מוגדר). לא זורק אם הפוש נכשל.
export async function notifyOwner(n: NewNotification): Promise<void> {
  const owner = await getAdmin();
  await notifyUser(owner.username, n);
}

export async function listNotifications(username: string, limit = 30) {
  return prisma.notification.findMany({
    where: { forUsername: username },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function unreadCount(username: string): Promise<number> {
  return prisma.notification.count({ where: { forUsername: username, read: false } });
}

export async function markRead(username: string, id?: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { forUsername: username, ...(id ? { id } : {}) },
    data: { read: true },
  });
}
