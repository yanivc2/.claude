import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";

// DELETE /api/companies/[id] — מחיקת חברה מרשימת האפשרויות. בעלים בלבד.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner(req);
  if (!owner) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  try {
    await prisma.company.delete({ where: { id } });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "שגיאה במחיקת החברה." }, { status: 500 });
  }
}
