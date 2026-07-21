import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession, getAuthConfig } from "./auth";
import { getAdminByUsername } from "./admin";

// עזרי סשן לצד השרת (Server Components) — קוראים את עוגיית הסשן דרך next/headers.

export async function currentUsername(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token, getAuthConfig().secret);
}

// המשתמש המחובר (רשומת AdminUser מלאה) או null.
export async function currentAdmin() {
  const username = await currentUsername();
  return username ? getAdminByUsername(username) : null;
}
