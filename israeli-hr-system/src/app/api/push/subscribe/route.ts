import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sessionUser } from "@/lib/webauthn";
import { pushEnabled } from "@/lib/push";

const schema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

// GET /api/push/subscribe — מצב הפוש ומפתח ה-VAPID הציבורי (ללקוח).
// זמין לכל משתמש מחובר (מנהל או עובד).
export async function GET(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const publicKey =
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || null;
  return NextResponse.json({ enabled: pushEnabled(), publicKey });
}

// POST /api/push/subscribe — שמירת מנוי Web Push של המכשיר הנוכחי (מנהל/עובד).
export async function POST(req: Request) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "מנוי לא תקין" }, { status: 400 });

  const { endpoint, keys } = parsed.data;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { username, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    update: { username, p256dh: keys.p256dh, auth: keys.auth },
  });
  return NextResponse.json({ status: "ok" }, { status: 201 });
}
