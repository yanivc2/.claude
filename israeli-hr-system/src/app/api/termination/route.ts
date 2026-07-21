import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  generateHearingInvitation,
  generateTerminationLetter,
  type ReasonItem,
} from "@/lib/documentGenerator";

const schema = z.object({
  employeeId: z.string(),
  docType: z.enum(["HEARING_INVITATION", "TERMINATION_LETTER"]),
  // רובריקות נבחרות + פירוט אופציונלי לכל אחת
  reasons: z
    .array(z.object({ title: z.string().min(1), detail: z.string().optional().default("") }))
    .optional()
    .default([]),
  // מלל חופשי נוסף
  notes: z.string().optional().default(""),
  companyName: z.string().optional().nullable(),
  hearingDate: z.string().nullable().optional(),
});

// מרכיב סיכום טקסטואלי של הנימוקים לשמירה במסד.
function reasonSummary(reasons: ReasonItem[], notes: string): string {
  const parts = reasons.map((r) => (r.detail ? `${r.title}: ${r.detail}` : r.title));
  if (notes.trim()) parts.push(notes.trim());
  return parts.join(" · ") || "—";
}

// POST /api/termination — הפקת מסמכי סיום העסקה עם חישוב הודעה מוקדמת.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });
  }
  const { employeeId, docType, reasons, notes, companyName, hearingDate } = parsed.data;

  if (reasons.length === 0 && !notes.trim()) {
    return NextResponse.json({ error: "יש לבחור נימוק אחד לפחות או להוסיף מלל." }, { status: 400 });
  }

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
  const summary = reasonSummary(reasons, notes);

  if (docType === "HEARING_INVITATION") {
    const { title, html } = generateHearingInvitation({
      employee: employeeInfo,
      hearingDate: hearingDate ? new Date(hearingDate) : new Date(),
      reasons,
      notes,
      companyName,
    });

    await prisma.terminationDocument.create({
      data: {
        employeeId,
        type: "HEARING_INVITATION",
        content: html,
        reason: summary,
        hearingDate: hearingDate ? new Date(hearingDate) : null,
      },
    });

    return NextResponse.json({ type: docType, title, html });
  }

  // מכתב סיום העסקה — כולל חישוב אוטומטי של ההודעה המוקדמת ומעבר לתקופת הודעה.
  const { title, html, noticeDays, lastWorkingDay } = generateTerminationLetter({
    employee: employeeInfo,
    reasons,
    notes,
    companyName,
  });

  await prisma.$transaction([
    prisma.terminationDocument.create({
      data: {
        employeeId,
        type: "TERMINATION_LETTER",
        content: html,
        reason: summary,
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
