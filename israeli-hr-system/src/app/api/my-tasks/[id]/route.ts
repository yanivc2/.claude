import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { employeeFromRequest } from "@/lib/employee-auth";
import { notifyUser } from "@/lib/notifications";

const schema = z.object({ status: z.enum(["SENT", "DONE"]) });

// PATCH /api/my-tasks/[id] — העובד מסמן משימה כבוצעה (או מבטל). בסימון "בוצע"
// נשלחת התראה + פוש למנהל שיצר. מוגבל למשימות בהיקף העובד (מונע נגיעה בזרים).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await employeeFromRequest(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });

  const task = await prisma.task.findUnique({ where: { id } });
  // רק משימה שמשויכת לעובד או להיקף החברה שלו.
  const mine =
    !!task &&
    (task.employeeId === me.id ||
      (["ALL", "TEAM"].includes(task.assigneeScope) && task.companyId === me.companyId));
  if (!task || !mine) return NextResponse.json({ error: "המשימה לא נמצאה" }, { status: 404 });

  const done = parsed.data.status === "DONE";
  await prisma.task.update({
    where: { id },
    data: { status: parsed.data.status, doneAt: done ? new Date() : null },
  });

  if (done && task.status !== "DONE") {
    await notifyUser(task.createdBy, {
      type: "TASK_DONE",
      title: "משימה בוצעה",
      body: `${me.firstName} ${me.lastName}: ${task.title}`,
      link: "/tasks",
      actorName: `${me.firstName} ${me.lastName}`,
      companyId: task.companyId,
    }).catch(() => {});
  }
  return NextResponse.json({ status: "ok" });
}
