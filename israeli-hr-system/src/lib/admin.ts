import { prisma } from "./prisma";
import { getAuthConfig } from "./auth";
import { hashPassword } from "./password";

// מבטיח קיום משתמש מנהל. אם אין — יוצר אותו מברירות המחדל/משתני הסביבה.
// לאחר הזריעה הראשונית, המסד הוא מקור האמת (כולל שינויי סיסמה מהאפליקציה).
export async function ensureAdmin() {
  const existing = await prisma.adminUser.findFirst();
  if (existing) return existing;
  const cfg = getAuthConfig();
  return prisma.adminUser.create({
    data: {
      username: cfg.username,
      name: cfg.name,
      email: cfg.email,
      passwordHash: await hashPassword(cfg.password),
    },
  });
}

export async function getAdmin() {
  return prisma.adminUser.findFirst();
}
