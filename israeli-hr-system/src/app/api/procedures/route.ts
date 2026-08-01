import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, roleOf } from "@/lib/rbac";
import { PROCEDURE_TYPES } from "@/lib/procedure-types";

// GET /api/procedures — נהלי משמרת. מסונן לחברה למנהל חנות.
export async function GET(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const where = roleOf(me) === "STORE_MANAGER" ? { companyId: me.companyId ?? "__none__" } : {};
  const procedures = await prisma.shiftProcedure.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // שמות העובדים המשויכים (לתצוגה).
  const empIds = [
    ...new Set(
      procedures.flatMap((p) => [p.employeeId, ...p.employeeIds]).filter(Boolean) as string[],
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
    procedures.map((p) => {
      const ids = p.employeeIds.length ? p.employeeIds : p.employeeId ? [p.employeeId] : [];
      const names = ids.map((id) => nameById.get(id)).filter(Boolean) as string[];
      return { ...p, employeeIdList: ids, employeeNames: names };
    }),
  );
}

const schema = z.object({
  type: z.enum(PROCEDURE_TYPES),
  assigneeScope: z.enum(["ALL", "TEAM", "EMPLOYEE"]).default("ALL"),
  employeeId: z.string().optional().nullable(),
  employeeIds: z.array(z.string()).optional().default([]),
  items: z.array(z.string().trim().min(1)).min(1, "יש להזין סעיף אחד לפחות"),
});

// POST /api/procedures — יצירת נוהל משמרת ושיוכו.
export async function POST(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים שגויים" }, { status: 400 });
  }
  const d = parsed.data;
  const employeeIds =
    d.assigneeScope === "EMPLOYEE"
      ? [...new Set([...(d.employeeIds ?? []), ...(d.employeeId ? [d.employeeId] : [])])]
      : [];
  if (d.assigneeScope === "EMPLOYEE" && employeeIds.length === 0) {
    return NextResponse.json({ error: "יש לבחור עובד אחד לפחות" }, { status: 400 });
  }
  const proc = await prisma.shiftProcedure.create({
    data: {
      type: d.type,
      assigneeScope: d.assigneeScope,
      employeeId: employeeIds[0] ?? null,
      employeeIds,
      companyId: me.companyId,
      items: d.items,
      createdBy: me.username,
    },
  });
  return NextResponse.json({ id: proc.id }, { status: 201 });
}
