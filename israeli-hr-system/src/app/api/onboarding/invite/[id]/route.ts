import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// DELETE /api/onboarding/invite/[id] — מחיקת קישור קליטה.
// מוחק רק את ההזמנה עצמה; אם כבר נוצר עובד מההזמנה, העובד נשאר.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await prisma.onboardingInvite.delete({ where: { id } });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ error: "שגיאה במחיקת הקישור." }, { status: 500 });
  }
}
