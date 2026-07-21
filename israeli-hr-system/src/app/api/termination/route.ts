import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  generateHearingInvitation,
  generateTerminationLetter,
} from "@/lib/documentGenerator";

const schema = z.object({
  employeeId: z.string(),
  docType: z.enum(["HEARING_INVITATION", "TERMINATION_LETTER"]),
  reason: z.string().min(1),
  hearingDate: z.string().nullable().optional(),
});

// POST /api/termination — הפקת מסמכי סיום העסקה עם חישוב הודעה מוקדמת.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });
  }
  const { employeeId, docType, reason, hearingDate } = parsed.data;

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) {
    return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });
  }

  const employeeInfo = {
    firstName: employee.firstName,
    lastName: employee.lastName,
    nationalId: employee.nationalId,
    jobTitle: employee.jobTitle,
    department: employee.department,
    startDate: employee.startDate,
  };

  if (docType === "HEARING_INVITATION") {
    const { title, html } = generateHearingInvitation({
      employee: employeeInfo,
      hearingDate: hearingDate ? new Date(hearingDate) : new Date(),
      reason,
    });

    await prisma.terminationDocument.create({
      data: {
        employeeId,
        type: "HEARING_INVITATION",
        content: html,
        reason,
        hearingDate: hearingDate ? new Date(hearingDate) : null,
      },
    });

    return NextResponse.json({ type: docType, title, html });
  }

  // מכתב סיום העסקה — כולל חישוב אוטומטי של ההודעה המוקדמת ומעבר לתקופת הודעה.
  const { title, html, noticeDays, lastWorkingDay } = generateTerminationLetter({
    employee: employeeInfo,
    reason,
  });

  await prisma.$transaction([
    prisma.terminationDocument.create({
      data: {
        employeeId,
        type: "TERMINATION_LETTER",
        content: html,
        reason,
        noticeDays,
        lastWorkingDay,
      },
    }),
    prisma.employee.update({
      where: { id: employeeId },
      data: { status: "NOTICE_PERIOD", endDate: lastWorkingDay },
    }),
  ]);

  return NextResponse.json({
    type: docType,
    title,
    html,
    noticeDays,
    lastWorkingDay: lastWorkingDay.toISOString(),
  });
}
