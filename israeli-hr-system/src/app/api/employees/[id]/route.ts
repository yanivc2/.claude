import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const patchSchema = z.object({
  status: z.enum(["ONBOARDING", "ACTIVE", "NOTICE_PERIOD", "INACTIVE", "TERMINATED"]),
});

// PATCH /api/employees/[id] — עדכון סטטוס העובד (למשל העברה ל"לא פעיל").
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "סטטוס שגוי" }, { status: 400 });
  }
  try {
    await prisma.employee.update({ where: { id }, data: { status: parsed.data.status } });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "שגיאה בעדכון העובד." }, { status: 500 });
  }
}

// DELETE /api/employees/[id] — מחיקת עובד וכל המסמכים/החתימות הקשורים (Cascade).
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await prisma.employee.delete({ where: { id } });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "שגיאה במחיקת העובד." }, { status: 500 });
  }
}
