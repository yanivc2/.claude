import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, canAccessEmployeeRecord } from "@/lib/rbac";
import { PROCEDURE_TYPES } from "@/lib/procedure-types";

const schema = z.object({
  type: z.enum(PROCEDURE_TYPES).optional(),
  assigneeScope: z.enum(["ALL", "TEAM", "EMPLOYEE"]).optional(),
  employeeIds: z.array(z.string()).optional(),
  items: z.array(z.string().trim().min(1)).min(1, "יש להזין סעיף אחד לפחות").optional(),
});

// PATCH /api/procedures/[id] — עריכת נוהל משמרת (סוג, שיוך, סעיפים).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "נתונים שגויים" }, { status: 400 });
  }

  const proc = await prisma.shiftProcedure.findUnique({ where: { id } });
  if (!proc) return NextResponse.json({ error: "הנוהל לא נמצא" }, { status: 404 });
  if (!canAccessEmployeeRecord(me, proc.companyId)) {
    return NextResponse.json({ error: "הנוהל לא נמצא" }, { status: 404 });
  }

  const d = parsed.data;
  const scope = d.assigneeScope ?? proc.assigneeScope;
  const employeeIds =
    scope === "EMPLOYEE" ? (d.employeeIds ?? proc.employeeIds).filter(Boolean) : [];
  if (scope === "EMPLOYEE" && employeeIds.length === 0) {
    return NextResponse.json({ error: "יש לבחור עובד אחד לפחות" }, { status: 400 });
  }

  await prisma.shiftProcedure.update({
    where: { id },
    data: {
      ...(d.type !== undefined ? { type: d.type } : {}),
      ...(d.assigneeScope !== undefined || d.employeeIds !== undefined
        ? { assigneeScope: scope, employeeIds, employeeId: employeeIds[0] ?? null }
        : {}),
      ...(d.items !== undefined ? { items: d.items } : {}),
    },
  });
  return NextResponse.json({ status: "ok" });
}

// DELETE /api/procedures/[id] — מחיקת נוהל משמרת.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await ctx.params;

  const proc = await prisma.shiftProcedure.findUnique({ where: { id } });
  if (!proc) return NextResponse.json({ error: "הנוהל לא נמצא" }, { status: 404 });
  if (!canAccessEmployeeRecord(me, proc.companyId)) {
    return NextResponse.json({ error: "הנוהל לא נמצא" }, { status: 404 });
  }

  await prisma.shiftProcedure.delete({ where: { id } });
  return NextResponse.json({ status: "ok" });
}
