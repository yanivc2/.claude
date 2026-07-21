import { prisma } from "./prisma";
import { getAuthConfig } from "./auth";
import { hashPassword } from "./password";

// מבטיח קיום משתמש בעלים (owner). אם אין אף משתמש — יוצר אותו מברירות
// המחדל/משתני הסביבה. אם קיימים משתמשים אך אף אחד אינו מסומן כבעלים (מסד
// שנוצר לפני תוספת המשתמשים) — מסמן את המשתמש הוותיק ביותר כבעלים.
// לאחר הזריעה הראשונית, המסד הוא מקור האמת (כולל שינויי סיסמה מהאפליקציה).
export async function ensureAdmin() {
  const owner = await prisma.adminUser.findFirst({ where: { isOwner: true } });
  if (owner) return owner;

  const earliest = await prisma.adminUser.findFirst({ orderBy: { createdAt: "asc" } });
  if (earliest) {
    // נרמול חד-פעמי: המשתמש הוותיק ביותר הופך לבעלים.
    return prisma.adminUser.update({ where: { id: earliest.id }, data: { isOwner: true } });
  }

  const cfg = getAuthConfig();
  return prisma.adminUser.create({
    data: {
      username: cfg.username,
      name: cfg.name,
      email: cfg.email,
      passwordHash: await hashPassword(cfg.password),
      isOwner: true,
      active: true,
    },
  });
}

// המשתמש הבעלים (מקור אמת לזרימות ברמת המערכת, כמו כניסת passkey).
export async function getAdmin() {
  return ensureAdmin();
}

// שליפת משתמש לפי שם משתמש (לכניסה ולזיהוי המשתמש המחובר).
export async function getAdminByUsername(username: string) {
  return prisma.adminUser.findUnique({ where: { username } });
}

// רשימת כל המשתמשים (לניהול בידי הבעלים).
export async function listAdmins() {
  return prisma.adminUser.findMany({ orderBy: { createdAt: "asc" } });
}
