import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireWriter, roleOf } from "@/lib/rbac";

// DELETE /api/resources/[id] — מחיקת משאב.
//   בעלים  — מוחק כל משאב.
//   מזכירה — מוחקת כל משאב פרט לכאלה שהבעלים העלה (uploadedByRole=OWNER).
//   מנהל   — אינו מוחק.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  const resource = await prisma.resource.findUnique({
    where: { id },
    select: { uploadedByRole: true },
  });
  if (!resource) return NextResponse.json({ error: "הפריט לא נמצא" }, { status: 404 });

  // כלל המזכירה: אין למחוק קובץ שהבעלים העלה.
  if (roleOf(me) === "SECRETARY" && resource.uploadedByRole === "OWNER") {
    return NextResponse.json(
      { error: "אין הרשאה למחוק קובץ שהעלה בעל המערכת" },
      { status: 403 },
    );
  }

  await prisma.resource.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ status: "ok" });
}

const patchSchema = z.object({
  // null מפורש = הוצאה מתיקייה (רמה עליונה); מחרוזת = העברה לתיקייה.
  folderId: z.string().nullable().optional(),
  // אישור/דחייה של פריט ממתין — בעלים בלבד.
  status: z.enum(["APPROVED", "REJECTED"]).optional(),
});

// PATCH /api/resources/[id] — העברה לתיקייה (בעלים/מזכירה) או אישור/דחיית
// פריט ממתין (בעלים בלבד).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });

  const role = roleOf(me);
  const data: { folderId?: string | null; status?: "APPROVED" | "REJECTED" } = {};

  if (parsed.data.status !== undefined) {
    if (role !== "OWNER") {
      return NextResponse.json({ error: "אישור מסמכים — לבעלים בלבד" }, { status: 403 });
    }
    data.status = parsed.data.status;
  }
  if (parsed.data.folderId !== undefined) {
    if (role !== "OWNER" && role !== "SECRETARY") {
      return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
    }
    data.folderId = parsed.data.folderId;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "אין שינוי לביצוע" }, { status: 400 });
  }

  await prisma.resource.update({ where: { id }, data }).catch(() => null);
  return NextResponse.json({ status: "ok" });
}
