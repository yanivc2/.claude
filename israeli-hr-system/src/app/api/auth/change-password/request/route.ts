import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAdminByUsername } from "@/lib/admin";
import { hashPassword, verifyPassword } from "@/lib/password";
import { sendEmail } from "@/lib/email";
import { sessionUser } from "@/lib/webauthn";

const schema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(6, "סיסמה חדשה חייבת לפחות 6 תווים"),
});

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return email;
  return `${name.slice(0, 2)}***@${domain}`;
}

// POST — בקשת שינוי סיסמה: מאמת סיסמה נוכחית, שולח קוד אישור למייל.
export async function POST(req: Request) {
  const user = await sessionUser(req);
  if (!user) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "נתונים שגויים" },
      { status: 400 },
    );
  }

  const admin = await getAdminByUsername(user);
  if (!admin) return NextResponse.json({ error: "משתמש לא נמצא" }, { status: 404 });

  if (!(await verifyPassword(parsed.data.currentPassword, admin.passwordHash))) {
    return NextResponse.json({ error: "הסיסמה הנוכחית שגויה" }, { status: 400 });
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: {
      pendingPasswordHash: await hashPassword(parsed.data.newPassword),
      confirmCodeHash: await hashPassword(code),
      confirmExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });

  const sent = await sendEmail({
    to: admin.email,
    subject: "קוד אישור לשינוי סיסמה — מערכת משאבי אנוש",
    html: `<div dir="rtl" style="font-family:Arial,sans-serif">
      <p>שלום ${admin.name},</p>
      <p>קוד האישור לשינוי הסיסמה שלך הוא:</p>
      <p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>
      <p>הקוד תקף ל-15 דקות. אם לא ביקשת לשנות סיסמה, ניתן להתעלם מהודעה זו.</p>
    </div>`,
  });

  // אם המייל אינו מוגדר (RESEND_API_KEY חסר) — מחזירים את הקוד כדי לא לחסום.
  return NextResponse.json({
    emailSent: sent,
    email: maskEmail(admin.email),
    ...(sent ? {} : { code }),
  });
}
