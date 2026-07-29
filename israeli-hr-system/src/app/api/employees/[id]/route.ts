import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireWriter, canAccessEmployee } from "@/lib/rbac";

const patchSchema = z
  .object({
    status: z.enum(["ONBOARDING", "ACTIVE", "NOTICE_PERIOD", "INACTIVE", "TERMINATED"]).optional(),
    // שיוך/שינוי חברה. null מנתק שיוך. undefined = ללא שינוי.
    companyId: z.string().nullable().optional(),
  })
  .refine((d) => d.status !== undefined || d.companyId !== undefined, {
    message: "אין שדות לעדכון",
  });

// PATCH /api/employees/[id] — עדכון סטטוס העובד (למשל העברה ל"לא פעיל").
// כתיבה: בעלים/מזכירה בלבד (מנהל חנות — צפייה בלבד).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  if (!(await canAccessEmployee(me, id))) {
    return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים שגויים" }, { status: 400 });
  }
  const data: { status?: (typeof parsed.data)["status"]; companyId?: string | null } = {};
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (parsed.data.companyId !== undefined) data.companyId = parsed.data.companyId || null;
  try {
    await prisma.employee.update({ where: { id }, data });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "שגיאה בעדכון העובד." }, { status: 500 });
  }
}

// DELETE /api/employees/[id] — מחיקת עובד וכל המסמכים/החתימות הקשורים (Cascade).
// כתיבה: בעלים/מזכירה בלבד.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  if (!(await canAccessEmployee(me, id))) {
    return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });
  }
  try {
    await prisma.employee.delete({ where: { id } });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "שגיאה במחיקת העובד." }, { status: 500 });
  }
}
