import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAuthConfig, signSession, SESSION_COOKIE } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import { EMP_PREFIX } from "@/lib/session";

const schema = z.object({ email: z.string().trim(), password: z.string() });

// POST /api/auth/employee-login — כניסת עובד (self-service) עם דוא״ל + סיסמה.
// הסשן מסומן בקידומת emp: ומצביע על מזהה העובד — נפרד לחלוטין מסשן מנהל.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים חסרים" }, { status: 400 });

  const employee = await prisma.employee.findFirst({
    where: { email: { equals: parsed.data.email, mode: "insensitive" } },
  });

  let ok = false;
  if (employee?.passwordHash) {
    ok = await verifyPassword(parsed.data.password, employee.passwordHash);
  } else {
    // גיבוב דמה לשמירת זמן תגובה אחיד (מונע מיפוי כתובות/עובדים).
    await hashPassword(parsed.data.password);
  }

  if (!employee || !employee.passwordHash || !ok) {
    return NextResponse.json({ error: "דוא״ל או סיסמה שגויים" }, { status: 401 });
  }

  const token = await signSession(`${EMP_PREFIX}${employee.id}`, getAuthConfig().secret);
  const res = NextResponse.json({ status: "ok" });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
