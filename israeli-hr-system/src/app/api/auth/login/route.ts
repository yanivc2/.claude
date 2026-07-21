import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthConfig, safeEqual, signSession, SESSION_COOKIE } from "@/lib/auth";
import { ensureAdmin } from "@/lib/admin";
import { verifyPassword } from "@/lib/password";

const schema = z.object({ username: z.string(), password: z.string() });

// POST /api/auth/login — כניסה עם שם משתמש וסיסמה (מול המנהל שבמסד).
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים חסרים" }, { status: 400 });
  }

  const admin = await ensureAdmin();
  const ok =
    safeEqual(parsed.data.username.trim(), admin.username) &&
    (await verifyPassword(parsed.data.password, admin.passwordHash));
  if (!ok) {
    return NextResponse.json({ error: "שם משתמש או סיסמה שגויים" }, { status: 401 });
  }

  const token = await signSession(admin.username, getAuthConfig().secret);
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
