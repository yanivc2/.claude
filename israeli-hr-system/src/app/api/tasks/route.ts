import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, roleOf } from "@/lib/rbac";
import { notifyUser } from "@/lib/notifications";

// היקף חברה למשימות (מנהל חנות — החברה שלו בלבד).
function taskScope(me: { companyId: string | null }, role: string) {
  return role === "STORE_MANAGER" ? { companyId: me.companyId ?? "__none__" } : {};
}

// GET /api/tasks — רשימת המשימות (מנהל). מסונן לפי חברה למנהל חנות.
export async function GET(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const tasks = await prisma.task.findMany({
    where: taskScope(me, roleOf(me)),
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  // שמות עובדים משויכים (לתצוגה).
  const empIds = [...new Set(tasks.map((t) => t.employeeId).filter(Boolean) as string[])];
  const emps = empIds.length
    ? await prisma.employee.findMany({
        where: { id: { in: empIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const nameById = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  return NextResponse.json(
    tasks.map((t) => ({ ...t, employeeName: t.employeeId ? nameById.get(t.employeeId) ?? null : null })),
  );
}

const schema = z.object({
  title: z.string().trim().min(1, "יש להזין תיאור משימה"),
  assigneeScope: z.enum(["ALL", "TEAM", "EMPLOYEE"]).default("ALL"),
  employeeId: z.string().optional().nullable(),
});

// POST /api/tasks — יצירת משימה ושיוכה. בעלים/מזכירה/מנהל חנות.
export async function POST(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים שגויים" }, { status: 400 });
  }
  const d = parsed.data;
  const employeeId = d.assigneeScope === "EMPLOYEE" ? d.employeeId || null : null;
  if (d.assigneeScope === "EMPLOYEE" && !employeeId) {
    return NextResponse.json({ error: "יש לבחור עובד" }, { status: 400 });
  }

  // עובד ספציפי — נגזר גם ה-companyId מהעובד (לצורך היקף).
  let companyId = me.companyId;
  if (employeeId) {
    const emp = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { companyId: true, email: true, firstName: true, lastName: true },
    });
    if (!emp) return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });
    companyId = emp.companyId;
    // התראה + פוש לעובד (מזוהה לפי המייל שלו, שישמש כשם משתמש בכניסת עובדים).
    await notifyUser(emp.email, {
      type: "TASK_ASSIGNED",
      title: "משימה חדשה מהמנהל",
      body: d.title,
      link: "/my-tasks",
      actorName: me.name,
      companyId,
    }).catch(() => {});
  }

  const task = await prisma.task.create({
    data: {
      title: d.title,
      assigneeScope: d.assigneeScope,
      employeeId,
      companyId,
      createdBy: me.username,
    },
  });
  return NextResponse.json({ id: task.id }, { status: 201 });
}
