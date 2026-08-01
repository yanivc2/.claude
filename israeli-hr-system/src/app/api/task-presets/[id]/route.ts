import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/rbac";

// DELETE /api/task-presets/[id] — מחיקת רובריקה לשימוש חוזר.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await ctx.params;
  await prisma.taskPreset.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ status: "ok" });
}
