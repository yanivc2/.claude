import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAdminByUsername } from "@/lib/admin";
import { hashPassword, verifyPassword } from "@/lib/password";

const schema = z.object({
  username: z.string().trim().min(1),
  code: z.string().trim().min(4),
  newPassword: z.string().min(6, "סיסמה חדשה חייבת לפחות 6 תווים"),
});

// POST /api/auth/forgot-password/confirm — אימות קוד וקביעת סיסמה חדשה.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים שגויים" },
      { status: 400 },
    );
  }

  const admin = await getAdminByUsername(parsed.data.username);
  if (!admin || !admin.confirmCodeHash || !admin.confirmExpiresAt) {
    return NextResponse.json({ error: "לא נמצאה בקשת איפוס. יש לבקש קוד חדש." }, { status: 400 });
  }
  if (admin.confirmExpiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "הקוד פג תוקף. יש לבקש קוד חדש." }, { status: 400 });
  }
  if (!(await verifyPassword(parsed.data.code, admin.confirmCodeHash))) {
    return NextResponse.json({ error: "קוד שגוי." }, { status: 400 });
  }

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
      pendingPasswordHash: null,
      confirmCodeHash: null,
      confirmExpiresAt: null,
    },
  });
  return NextResponse.json({ status: "ok" });
}
