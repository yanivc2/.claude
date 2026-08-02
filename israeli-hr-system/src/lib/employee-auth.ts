import type { Employee } from "@prisma/client";
import { prisma } from "./prisma";
import { sessionUser } from "./webauthn";
import { EMP_PREFIX } from "./session";

// מחזיר את רשומת העובד המחובר מבקשת API, או null (אם אין סשן עובד).
export async function employeeFromRequest(req: Request): Promise<Employee | null> {
  const username = await sessionUser(req);
  if (!username || !username.startsWith(EMP_PREFIX)) return null;
  const id = username.slice(EMP_PREFIX.length);
  return prisma.employee.findUnique({ where: { id } }).catch(() => null);
}
