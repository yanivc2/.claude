import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireWriter } from "@/lib/rbac";

// DELETE /api/onboarding/invite/[id] — מחיקת קישור קליטה. בעלים/מזכירה בלבד.
// מוחק רק את ההזמנה עצמה; אם כבר נוצר עובד מההזמנה, העובד נשאר.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const { id } = await ctx.params;
  try {
    await prisma.onboardingInvite.delete({ where: { id } });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "שגיאה במחיקת הקישור." }, { status: 500 });
  }
}
