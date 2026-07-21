import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthConfig, safeEqual, signSession, SESSION_COOKIE } from "@/lib/auth";

const schema = z.object({ username: z.string(), password: z.string() });

// POST /api/auth/login — כניסה עם שם משתמש וסיסמה.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים חסרים" }, { status: 400 });
  }
  const cfg = getAuthConfig();
  const ok =
    safeEqual(parsed.data.username.trim(), cfg.username) &&
    safeEqual(parsed.data.password, cfg.password);
  if (!ok) {
    return NextResponse.json({ error: "שם משתמש או סיסמה שגויים" }, { status: 401 });
  }

  const token = await signSession(cfg.username, cfg.secret);
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
