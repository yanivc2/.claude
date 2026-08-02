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
  // שמות העובדים המשויכים (לתצוגה) — אוסף גם employeeId (ישן) וגם employeeIds (רב).
  const empIds = [
    ...new Set(
      tasks.flatMap((t) => [t.employeeId, ...t.employeeIds]).filter(Boolean) as string[],
    ),
  ];
  const emps = empIds.length
    ? await prisma.employee.findMany({
        where: { id: { in: empIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const nameById = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  return NextResponse.json(
    tasks.map((t) => {
      const ids = t.employeeIds.length ? t.employeeIds : t.employeeId ? [t.employeeId] : [];
      const names = ids.map((id) => nameById.get(id)).filter(Boolean) as string[];
      return { ...t, employeeName: names[0] ?? null, employeeNames: names };
    }),
  );
}

const schema = z.object({
  title: z.string().trim().min(1, "יש להזין תיאור משימה"),
  assigneeScope: z.enum(["ALL", "TEAM", "EMPLOYEE"]).default("ALL"),
  employeeId: z.string().optional().nullable(),
  employeeIds: z.array(z.string()).optional().default([]),
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
  // שיוך לעובדים ספציפיים — תומך גם בשדה הישן (employeeId בודד) וגם ברב (employeeIds).
  const employeeIds =
    d.assigneeScope === "EMPLOYEE"
      ? [...new Set([...(d.employeeIds ?? []), ...(d.employeeId ? [d.employeeId] : [])])]
      : [];
  if (d.assigneeScope === "EMPLOYEE" && employeeIds.length === 0) {
    return NextResponse.json({ error: "יש לבחור עובד אחד לפחות" }, { status: 400 });
  }

  // עובדים ספציפיים — נגזר ה-companyId מהעובד הראשון (לצורך היקף) ונשלחת התראה לכל אחד.
  let companyId = me.companyId;
  if (employeeIds.length) {
    const emps = await prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, companyId: true },
    });
    if (emps.length === 0) return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });
    companyId = emps[0].companyId;
    // התראה + פוש לכל עובד (מזוהה לפי סשן העובד: emp:<id>).
    await Promise.all(
      emps.map((emp) =>
        notifyUser(`emp:${emp.id}`, {
          type: "TASK_ASSIGNED",
          title: "משימה חדשה מהמנהל",
          body: d.title,
          link: "/my-tasks",
          actorName: me.name,
          companyId: emp.companyId,
        }).catch(() => {}),
      ),
    );
  }

  const task = await prisma.task.create({
    data: {
      title: d.title,
      assigneeScope: d.assigneeScope,
      employeeId: employeeIds[0] ?? null,
      employeeIds,
      companyId,
      createdBy: me.username,
    },
  });
  return NextResponse.json({ id: task.id }, { status: 201 });
}
