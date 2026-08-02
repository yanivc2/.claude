import { NextResponse } from "next/server";
import { z } from "zod";
import { sessionUser } from "@/lib/webauthn";
import { listNotifications, unreadCount, markRead } from "@/lib/notifications";

// GET /api/notifications — התראות המשתמש המחובר (מנהל/עובד) + מספר שלא נקראו.
export async function GET(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const [items, unread] = await Promise.all([
    listNotifications(username),
    unreadCount(username),
  ]);
  return NextResponse.json({ unread, items });
}

const patchSchema = z.object({ id: z.string().optional(), all: z.boolean().optional() });

// PATCH /api/notifications — סימון התראה (id) או הכל (all) כנקראו.
export async function PATCH(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });
  await markRead(username, parsed.data.all ? undefined : parsed.data.id);
  return NextResponse.json({ status: "ok" });
}
