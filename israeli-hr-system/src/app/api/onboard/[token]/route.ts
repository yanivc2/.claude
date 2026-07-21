import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  onboardingSchema,
  createEmployeeFromOnboarding,
  onboardingErrorMessage,
} from "@/lib/onboarding";

// POST /api/onboard/[token] — הגשת קליטה ע"י העובד עצמו דרך קישור ההזמנה.
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const invite = await prisma.onboardingInvite.findUnique({ where: { token } });
  if (!invite) {
    return NextResponse.json({ error: "הקישור אינו תקין." }, { status: 404 });
  }
  if (invite.status !== "PENDING") {
    return NextResponse.json(
      { error: "קישור זה כבר נוצל או בוטל. פנה/י למשאבי אנוש." },
      { status: 410 },
    );
  }

  const parsed = onboardingSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "נתונים שגויים", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // צירוף הסכם העבודה שה-HR העלה בעת יצירת ההזמנה — נשמר בתיק העובד.
  const data = { ...parsed.data };
  if (invite.contractFileData && invite.contractFileName) {
    data.contractAttachment = {
      fileName: invite.contractFileName,
      mimeType: invite.contractMimeType ?? "application/octet-stream",
      data: invite.contractFileData,
    };
  }

  try {
    const employeeId = await createEmployeeFromOnboarding(data);

    // סימון ההזמנה כהושלמה וקישורה לעובד שנוצר.
    await prisma.onboardingInvite.update({
      where: { id: invite.id },
      data: { status: "COMPLETED", completedAt: new Date(), employeeId },
    });

    return NextResponse.json({ status: "ok" }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: onboardingErrorMessage(err) }, { status: 500 });
  }
}
