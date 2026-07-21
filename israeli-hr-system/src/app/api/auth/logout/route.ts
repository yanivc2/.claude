import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

// POST /api/auth/logout — יציאה (מחיקת עוגיית הסשן).
export async function POST() {
  const res = NextResponse.json({ status: "ok" });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
