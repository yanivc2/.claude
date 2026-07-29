import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAdmin } from "@/lib/admin";
import { hashPassword } from "@/lib/password";
import { safeEqual } from "@/lib/auth";

const schema = z.object({
  secret: z.string().min(1),
  newPassword: z.string().min(6, "סיסמה חדשה חייבת לפחות 6 תווים"),
});

// POST /api/auth/emergency-reset — איפוס סיסמת הבעלים ללא מייל, באמצעות סוד
// חירום ממשתני הסביבה (OWNER_RESET_SECRET). פעיל אך ורק אם המשתנה מוגדר.
// נועד למצב שבו הבעלים ננעל בחוץ ושליחת המייל אינה זמינה.
export async function POST(req: Request) {
  const secret = process.env.OWNER_RESET_SECRET;
  // ללא הגדרת סוד — היכולת מושבתת לחלוטין.
  if (!secret) {
    return NextResponse.json(
      { error: "איפוס חירום אינו מופעל. יש להגדיר OWNER_RESET_SECRET ב-Vercel ולבצע Redeploy." },
      { status: 400 },
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים שגויים" },
      { status: 400 },
    );
  }
  if (!safeEqual(parsed.data.secret, secret)) {
    return NextResponse.json({ error: "סוד החירום שגוי." }, { status: 403 });
  }

  const owner = await getAdmin();
  await prisma.adminUser.update({
    where: { id: owner.id },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
      pendingPasswordHash: null,
      confirmCodeHash: null,
      confirmExpiresAt: null,
    },
  });
  return NextResponse.json({ status: "ok", username: owner.username });
}
