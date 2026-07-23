import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/authz";
import { sessionUser } from "@/lib/webauthn";

// DELETE /api/resources/[id] — מחיקת משאב. בעל המערכת בלבד.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const owner = await requireOwner(req);
  if (!owner) return NextResponse.json({ error: "לא מורשה" }, { status: 403 });

  const { id } = await ctx.params;
  await prisma.resource.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ status: "ok" });
}

// null מפורש = הוצאה מתיקייה (רמה עליונה); מחרוזת = העברה לתיקייה.
const patchSchema = z.object({ folderId: z.string().nullable() });

// PATCH /api/resources/[id] — העברת משאב לתיקייה. כל משתמש מחובר.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const username = await sessionUser(req);
  if (!username) return NextResponse.json({ error: "לא מורשה" }, { status: 401 });

  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });

  await prisma.resource
    .update({ where: { id }, data: { folderId: parsed.data.folderId } })
    .catch(() => null);
  return NextResponse.json({ status: "ok" });
}
