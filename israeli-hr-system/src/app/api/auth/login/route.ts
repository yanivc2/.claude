import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthConfig, signSession, SESSION_COOKIE } from "@/lib/auth";
import { ensureAdmin, getAdminByUsername } from "@/lib/admin";
import { hashPassword, verifyPassword } from "@/lib/password";

const schema = z.object({ username: z.string(), password: z.string() });

// POST /api/auth/login — כניסה עם שם משתמש וסיסמה (מול המשתמשים שבמסד).
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים חסרים" }, { status: 400 });
  }

  // מבטיח קיום הבעלים (זריעה ראשונית) לפני שמחפשים את המשתמש שהוזן.
  await ensureAdmin();
  const user = await getAdminByUsername(parsed.data.username.trim());

  let ok = false;
  if (user) {
    ok = user.active && (await verifyPassword(parsed.data.password, user.passwordHash));
  } else {
    // גיבוב דמה כשלא נמצא משתמש — לשמירת זמן תגובה דומה כדי שלא ידלוף מידע
    // האם שם המשתמש קיים (הגנה מפני מיפוי שמות משתמש).
    await hashPassword(parsed.data.password);
  }

  if (!user || !ok) {
    return NextResponse.json({ error: "שם משתמש או סיסמה שגויים" }, { status: 401 });
  }

  const token = await signSession(user.username, getAuthConfig().secret);
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
