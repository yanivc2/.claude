import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, canAccessEmployeeRecord } from "@/lib/rbac";
import { notifyUser } from "@/lib/notifications";

const schema = z
  .object({
    status: z.enum(["SENT", "DONE"]).optional(),
    title: z.string().trim().min(1, "יש להזין תיאור משימה").optional(),
  })
  .refine((d) => d.status !== undefined || d.title !== undefined, {
    message: "אין נתונים לעדכון",
  });

// PATCH /api/tasks/[id] — עדכון משימה: סטטוס (בוצע/ממתין) ו/או עריכת הכותרת.
// בסימון "בוצע" נשלחת התראה+פוש למנהל שיצר את המשימה.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים שגויים" }, { status: 400 });
  }

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
  // מנהל חנות — רק בהיקף החברה שלו (מונע נגיעה במשימות חברה אחרת).
  if (!canAccessEmployeeRecord(me, task.companyId)) {
    return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
  }

  const { status, title } = parsed.data;
  const done = status === "DONE";
  await prisma.task.update({
    where: { id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(status !== undefined ? { status, doneAt: done ? new Date() : null } : {}),
    },
  });

  // התראה למנהל שיצר, בעת סיום.
  if (done && task.status !== "DONE") {
    await notifyUser(task.createdBy, {
      type: "TASK_DONE",
      title: "משימה בוצעה",
      body: task.title,
      link: "/tasks",
      companyId: task.companyId,
    }).catch(() => {});
  }
  return NextResponse.json({ status: "ok" });
}

// DELETE /api/tasks/[id] — מחיקת משימה. בעלים/מזכירה/מנהל חנות (בהיקף החברה שלו).
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await ctx.params;

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
  if (!canAccessEmployeeRecord(me, task.companyId)) {
    return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });
  }

  await prisma.task.delete({ where: { id } });
  return NextResponse.json({ status: "ok" });
}
