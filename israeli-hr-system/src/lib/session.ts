import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession, getAuthConfig } from "./auth";
import { getAdminByUsername } from "./admin";
import { prisma } from "./prisma";

// עזרי סשן לצד השרת (Server Components) — קוראים את עוגיית הסשן דרך next/headers.

// סשן עובד מסומן בקידומת "emp:" בשם המשתמש. מנהלים אינם יכולים להכיל ":"
// בשם המשתמש (regex בהרשמה), ולכן זו הפרדה בטוחה בין עובד למנהל.
export const EMP_PREFIX = "emp:";

export async function currentUsername(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token, getAuthConfig().secret);
}

// המנהל המחובר (רשומת AdminUser מלאה) או null. סשן עובד לעולם לא יחזיר מנהל.
export async function currentAdmin() {
  const username = await currentUsername();
  if (!username || username.startsWith(EMP_PREFIX)) return null;
  return getAdminByUsername(username);
}

// העובד המחובר (רשומת Employee) או null. רק סשן מסוג עובד.
export async function currentEmployee() {
  const username = await currentUsername();
  if (!username || !username.startsWith(EMP_PREFIX)) return null;
  const id = username.slice(EMP_PREFIX.length);
  return prisma.employee.findUnique({ where: { id } }).catch(() => null);
}
