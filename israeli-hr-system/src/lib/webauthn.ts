import { SESSION_COOKIE, verifySession, getAuthConfig } from "./auth";

// מזהי ה-Relying Party נגזרים מהבקשה — כך זה עובד בכל דומיין (Vercel/localhost).
export function rpFromRequest(req: Request) {
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto =
    req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return {
    rpID: host.split(":")[0],
    origin: `${proto}://${host}`,
    rpName: "מערכת משאבי אנוש",
  };
}

export const REG_CHALLENGE_COOKIE = "wa_reg_chal";
export const LOGIN_CHALLENGE_COOKIE = "wa_login_chal";

// מחזיר את שם המשתמש המחובר מתוך עוגיית הסשן (או null).
export async function sessionUser(req: Request): Promise<string | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]), getAuthConfig().secret);
}
