import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWriter, roleOf, canAccessEmployeeRecord } from "@/lib/rbac";

// DELETE /api/documents/[id] — מחיקת מסמך עובד בודד.
//   בעלים  — מוחק כל מסמך.
//   מזכירה — מוחקת כל מסמך פרט לכאלה שהבעלים העלה (uploadedByRole=OWNER).
//   מנהל   — אינו מוחק (requireWriter חוסם).
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  const doc = await prisma.employeeDocument.findUnique({
    where: { id },
    select: { uploadedByRole: true, employee: { select: { companyId: true } } },
  });
  if (!doc) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });

  // היקף חברה (הגנת IDOR) — למרות שמזכירה/בעלים רואים הכל, נשמר לעקביות.
  if (!canAccessEmployeeRecord(me, doc.employee.companyId)) {
    return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });
  }

  // כלל המזכירה: אין למחוק מסמך שהבעלים העלה.
  if (roleOf(me) === "SECRETARY" && doc.uploadedByRole === "OWNER") {
    return NextResponse.json(
      { error: "אין הרשאה למחוק מסמך שהעלה בעל המערכת" },
      { status: 403 },
    );
  }

  await prisma.employeeDocument.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ status: "ok" });
}
