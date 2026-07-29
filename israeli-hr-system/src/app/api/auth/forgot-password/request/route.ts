import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAdminByUsername } from "@/lib/admin";
import { hashPassword } from "@/lib/password";
import { sendEmail, emailConfigured } from "@/lib/email";

const schema = z.object({ username: z.string().trim().min(1) });

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return email;
  return `${name.slice(0, 2)}***@${domain}`;
}

// POST /api/auth/forgot-password/request — איפוס סיסמה בשכחה (ללא כניסה).
// שולח קוד חד-פעמי לכתובת המייל של החשבון. אינו חושף את הקוד בתגובה
// (למניעת ניצול), ואינו מגלה אם שם המשתמש קיים.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "יש להזין שם משתמש" }, { status: 400 });

  const admin = await getAdminByUsername(parsed.data.username);

  // אם אין מייל מוגדר בשרת — לא ניתן לשלוח קוד; מפנים לאיפוס חירום.
  if (!emailConfigured()) {
    return NextResponse.json({
      emailSent: false,
      reason: "no_email",
    });
  }

  // תגובה אחידה בין אם המשתמש קיים או לא (מונע חשיפת שמות משתמש).
  if (admin && admin.active) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        // אין סיסמה ממתינה בשלב זה — רק קוד איפוס.
        pendingPasswordHash: null,
        confirmCodeHash: await hashPassword(code),
        confirmExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    await sendEmail({
      to: admin.email,
      subject: "קוד לאיפוס סיסמה — מערכת משאבי אנוש",
      html: `<div dir="rtl" style="font-family:Arial,sans-serif">
        <p>שלום ${admin.name},</p>
        <p>קוד לאיפוס הסיסמה שלך:</p>
        <p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>
        <p>הקוד תקף ל-15 דקות. אם לא ביקשת לאפס סיסמה — ניתן להתעלם מהודעה זו.</p>
      </div>`,
    });
    return NextResponse.json({ emailSent: true, email: maskEmail(admin.email) });
  }

  // משתמש לא קיים/מושבת — עדיין מחזירים "נשלח" כדי לא לחשוף מידע.
  return NextResponse.json({ emailSent: true, email: "***" });
}
