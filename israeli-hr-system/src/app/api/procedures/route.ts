import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, roleOf } from "@/lib/rbac";

// GET /api/procedures — נהלי משמרת (פתיחה/סגירה). מסונן לחברה למנהל חנות.
export async function GET(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  const where = roleOf(me) === "STORE_MANAGER" ? { companyId: me.companyId ?? "__none__" } : {};
  const procedures = await prisma.shiftProcedure.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json(procedures);
}

const schema = z.object({
  type: z.enum(["OPEN", "CLOSE"]),
  assigneeScope: z.enum(["ALL", "TEAM", "EMPLOYEE"]).default("ALL"),
  employeeId: z.string().optional().nullable(),
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
  const employeeId = d.assigneeScope === "EMPLOYEE" ? d.employeeId || null : null;
  const proc = await prisma.shiftProcedure.create({
    data: {
      type: d.type,
      assigneeScope: d.assigneeScope,
      employeeId,
      companyId: me.companyId,
      items: d.items,
      createdBy: me.username,
    },
  });
  return NextResponse.json({ id: proc.id }, { status: 201 });
}
