import type { AdminUser, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { sessionUser } from "./webauthn";
import { getAdminByUsername } from "./admin";

// ─────────────────────────────────────────────────────────────────────────
// שכבת בקרת הרשאות (RBAC) + הפרדה מולטי-חברה.
//
// שלוש רמות הרשאה (AdminRole):
//   OWNER         — בעל המערכת. הכל.
//   SECRETARY     — מזכירה. כמעט הכל; אינה מוחקת קבצים שהבעלים העלה.
//   STORE_MANAGER — מנהל חנות. צפייה בלבד, מוגבל לחברה המשויכת אליו, פלוס
//                   פעולות מוגדרות שנאכפות נקודתית (שלב 2).
//
// עיקרון-על אבטחתי: כל שאילתה על נתוני עובדים חייבת לעבור דרך employeeScope,
// וכל גישה לעובד בודד דרך assertEmployeeAccess — כדי שמנהל חנות לעולם לא
// יוכל לראות/לגעת בנתוני חברה אחרת (כולל ניחוש מזהה — IDOR).
// ─────────────────────────────────────────────────────────────────────────

export type AdminRole = "OWNER" | "SECRETARY" | "STORE_MANAGER";

// מזהה חברה בלתי-אפשרי — משמש לחסימה מוחלטת של מנהל ללא שיוך חברה.
const NO_COMPANY = "__no_company__";

type AdminLike = Pick<AdminUser, "role" | "isOwner" | "companyId">;

// מקור האמת להרשאה. isOwner נשמר לתאימות לאחור: אם רשומה ישנה מסומנת
// כבעלים אך עמודת role עדיין בברירת המחדל — הבעלים גובר.
export function roleOf(admin: AdminLike): AdminRole {
  if (admin.isOwner) return "OWNER";
  return (admin.role as AdminRole) ?? "SECRETARY";
}

export const isOwner = (a: AdminLike) => roleOf(a) === "OWNER";
export const isSecretary = (a: AdminLike) => roleOf(a) === "SECRETARY";
export const isStoreManager = (a: AdminLike) => roleOf(a) === "STORE_MANAGER";

// האם המשתמש רשאי לפעולות כתיבה כלליות על נתוני עובדים (יצירה/עריכה/מחיקה).
// שלב 1: בעלים ומזכירה בלבד. מנהל חנות — צפייה בלבד (פעולותיו המותרות
// נבדקות בנפרד בנקודתן).
export function canWriteEmployeeData(admin: AdminLike): boolean {
  const r = roleOf(admin);
  return r === "OWNER" || r === "SECRETARY";
}

// האם המשתמש רשאי לנהל משתמשים וחברות — בעלים בלבד.
export function canManageUsers(admin: AdminLike): boolean {
  return roleOf(admin) === "OWNER";
}

// פילטר Prisma להיקף העובדים הגלוי למשתמש.
//   בעלים/מזכירה — הכל (כולל עובדים ללא שיוך חברה).
//   מנהל חנות     — אך ורק החברה המשויכת אליו; ללא שיוך — כלום.
export function employeeScope(admin: AdminLike): Prisma.EmployeeWhereInput {
  if (roleOf(admin) === "STORE_MANAGER") {
    return { companyId: admin.companyId ?? NO_COMPANY };
  }
  return {};
}

// גרסה סינכרונית — כשכבר יש בידינו את companyId של העובד (חוסך שאילתה).
export function canAccessEmployeeRecord(
  admin: AdminLike,
  employeeCompanyId: string | null,
): boolean {
  if (roleOf(admin) !== "STORE_MANAGER") return true;
  return !!admin.companyId && employeeCompanyId === admin.companyId;
}

// האם המשתמש רשאי לגשת לעובד ספציפי. מונע IDOR: מנהל חנות המנחש מזהה של
// עובד מחברה אחרת ייחסם. בעלים/מזכירה — גישה מלאה.
export async function canAccessEmployee(
  admin: AdminLike,
  employeeId: string,
): Promise<boolean> {
  if (roleOf(admin) !== "STORE_MANAGER") return true;
  if (!admin.companyId) return false;
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { companyId: true },
  });
  return !!emp && emp.companyId === admin.companyId;
}

// שליפת רשומת המנהל המחובר מתוך בקשת API (או null אם אינו מחובר/מושבת).
export async function adminFromRequest(req: Request): Promise<AdminUser | null> {
  const username = await sessionUser(req);
  if (!username) return null;
  const me = await getAdminByUsername(username);
  return me && me.active ? me : null;
}

// עזרי-שער לנתיבי API — מחזירים את המנהל אם מורשה, אחרת null (הקורא מחזיר 401/403).
export async function requireAdmin(req: Request): Promise<AdminUser | null> {
  return adminFromRequest(req);
}

// דורש הרשאת כתיבה על נתוני עובדים (בעלים/מזכירה).
export async function requireWriter(req: Request): Promise<AdminUser | null> {
  const me = await adminFromRequest(req);
  return me && canWriteEmployeeData(me) ? me : null;
}

// תווית קריאה בעברית לרמת ההרשאה (לתצוגה).
export function roleLabel(role: AdminRole): string {
  switch (role) {
    case "OWNER":
      return "בעלים";
    case "SECRETARY":
      return "מזכירה";
    case "STORE_MANAGER":
      return "מנהל חנות";
  }
}
