import { NextResponse } from "next/server";
import { z } from "zod";
import { adminFromRequest } from "@/lib/rbac";
import { listNotifications, unreadCount, markRead } from "@/lib/notifications";

// GET /api/notifications — רשימת ההתראות של המשתמש המחובר + מספר שלא נקראו.
export async function GET(req: Request) {
  const me = await adminFromRequest(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const [items, unread] = await Promise.all([
    listNotifications(me.username),
    unreadCount(me.username),
  ]);
  return NextResponse.json({ unread, items });
}

const patchSchema = z.object({ id: z.string().optional(), all: z.boolean().optional() });

// PATCH /api/notifications — סימון התראה (id) או הכל (all) כנקראו.
export async function PATCH(req: Request) {
  const me = await adminFromRequest(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });
  await markRead(me.username, parsed.data.all ? undefined : parsed.data.id);
  return NextResponse.json({ status: "ok" });
}
