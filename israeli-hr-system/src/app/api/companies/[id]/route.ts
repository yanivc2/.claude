import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// DELETE /api/companies/[id] — מחיקת חברה מרשימת האפשרויות.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await prisma.company.delete({ where: { id } });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "שגיאה במחיקת החברה." }, { status: 500 });
  }
}
