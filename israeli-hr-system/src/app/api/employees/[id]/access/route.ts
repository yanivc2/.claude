import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWriter, canAccessEmployee } from "@/lib/rbac";
import { hashPassword } from "@/lib/password";

// יוצר סיסמה ראשונית קריאה (אותיות/ספרות, ללא תווים מבלבלים).
function genPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// POST /api/employees/[id]/access — יצירת/איפוס גישת עובד (self-service).
// בעלים/מזכירה בלבד. מחזיר סיסמה ראשונית פעם אחת לשיתוף עם העובד.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  if (!(await canAccessEmployee(me, id))) {
    return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });
  }
  const employee = await prisma.employee.findUnique({
    where: { id },
    select: { email: true, firstName: true, lastName: true },
  });
  if (!employee) return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });

  const password = genPassword();
  await prisma.employee.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });

  return NextResponse.json({
    email: employee.email,
    password,
    name: `${employee.firstName} ${employee.lastName}`,
  });
}
