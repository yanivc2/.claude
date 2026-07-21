import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAdminByUsername } from "@/lib/admin";
import { verifyPassword } from "@/lib/password";
import { sessionUser } from "@/lib/webauthn";

const schema = z.object({ code: z.string().min(4) });

// POST — אישור שינוי הסיסמה עם הקוד שנשלח למייל.
export async function POST(req: Request) {
  const user = await sessionUser(req);
  if (!user) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "קוד חסר" }, { status: 400 });

  const admin = await getAdminByUsername(user);
  if (!admin || !admin.pendingPasswordHash || !admin.confirmCodeHash || !admin.confirmExpiresAt) {
    return NextResponse.json({ error: "אין בקשת שינוי פעילה" }, { status: 400 });
  }
  if (admin.confirmExpiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "הקוד פג תוקף. התחל/י מחדש." }, { status: 400 });
  }
  if (!(await verifyPassword(parsed.data.code.trim(), admin.confirmCodeHash))) {
    return NextResponse.json({ error: "קוד שגוי" }, { status: 400 });
  }

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: {
      passwordHash: admin.pendingPasswordHash,
      pendingPasswordHash: null,
      confirmCodeHash: null,
      confirmExpiresAt: null,
    },
  });

  return NextResponse.json({ status: "ok" });
}
