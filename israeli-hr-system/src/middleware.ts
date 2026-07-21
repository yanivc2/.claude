import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession, getAuthConfig } from "@/lib/auth";

// נתיבים ציבוריים שאינם דורשים כניסה:
//  • דף הכניסה ונתיבי ה-API של האימות
//  • פורטל הקליטה של העובד (קישור טוקן) וה-API שלו
//  • ה-cron (מוגן בנפרד ע"י CRON_SECRET)
function isPublic(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/onboard/") ||
    pathname.startsWith("/api/onboard/") ||
    pathname.startsWith("/api/cron/")
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const user = token ? await verifySession(token, getAuthConfig().secret) : null;
  if (user) return NextResponse.next();

  // בקשת API מוגנת → 401; בקשת עמוד → הפניה לכניסה.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}

// מריצים על כל הנתיבים למעט קבצים סטטיים.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|txt)).*)"],
};
