import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";

// DELETE /api/resources/[id] — מחיקת משאב. בעל המערכת בלבד.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner(req);
  if (!owner) return NextResponse.json({ error: "לא מורשה" }, { status: 403 });

  const { id } = await ctx.params;
  await prisma.resource.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ status: "ok" });
}
