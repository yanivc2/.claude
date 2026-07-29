import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";
import { notifyUser } from "@/lib/notifications";

const schema = z.object({ status: z.enum(["SENT", "DONE"]) });

// PATCH /api/tasks/[id] — עדכון סטטוס משימה. בסימון "בוצע" נשלחת התראה+פוש
// למנהל שיצר את המשימה. (בשלב כניסת העובדים — גם העובד יוכל לסמן.)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });

  const done = parsed.data.status === "DONE";
  await prisma.task.update({
    where: { id },
    data: { status: parsed.data.status, doneAt: done ? new Date() : null },
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
