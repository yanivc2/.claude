import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  generateHearingInvitation,
  generateTerminationLetter,
  type ReasonItem,
} from "@/lib/documentGenerator";
import { requireAdmin, canAccessEmployee, isStoreManager } from "@/lib/rbac";
import { notifyOwner } from "@/lib/notifications";

const schema = z.object({
  employeeId: z.string(),
  docType: z.enum(["HEARING_INVITATION", "TERMINATION_LETTER", "TERMINATION_RESIGNATION"]),
  reasons: z
    .array(z.object({ title: z.string().min(1), detail: z.string().optional().default("") }))
    .optional()
    .default([]),
  notes: z.string().optional().default(""),
  companyName: z.string().optional().nullable(),
  signerName: z.string().optional().default(""),
  signerTitle: z.string().optional().default(""),
  gender: z.enum(["male", "female"]).optional().default("male"),
  // הזמנה לשימוע
  hearingDate: z.string().nullable().optional(),
  hearingTime: z.string().optional().default(""),
  location: z.string().optional().default(""),
  participants: z.string().optional().default(""),
  // מכתב סיום
  hearingAttended: z.boolean().optional().default(false),
});

function reasonSummary(reasons: ReasonItem[], notes: string): string {
  const parts = reasons.map((r) => (r.detail ? `${r.title}: ${r.detail}` : r.title));
  if (notes.trim()) parts.push(notes.trim());
  return parts.join(" · ") || "—";
}

// POST /api/termination — הפקת מסמכי סיום העסקה עם חישוב הודעה מוקדמת.
// מותר לכל מנהל מחובר (כולל מנהל חנות, מוגבל לעובדי חברתו). כשמנהל חנות
// מנפיק — נשלחת התראה + פוש לבעלים.
export async function POST(req: Request) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });
  }
  const d = parsed.data;

  if (d.reasons.length === 0 && !d.notes.trim()) {
    return NextResponse.json({ error: "יש לבחור נימוק אחד לפחות או להוסיף מלל." }, { status: 400 });
  }

  if (!(await canAccessEmployee(me, d.employeeId))) {
    return NextResponse.json({ error: "העובד לא נמצא" }, { status: 404 });
  }

  const employee = await prisma.employee.findUnique({ where: { id: d.employeeId } });
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
  const summary = reasonSummary(d.reasons, d.notes);
  const common = {
    reasons: d.reasons,
    notes: d.notes,
    companyName: d.companyName,
    signerName: d.signerName,
    signerTitle: d.signerTitle,
    gender: d.gender,
  };

  if (d.docType === "HEARING_INVITATION") {
    const { title, html } = generateHearingInvitation({
      employee: employeeInfo,
      hearingDate: d.hearingDate ? new Date(d.hearingDate) : new Date(),
      hearingTime: d.hearingTime,
      location: d.location,
      participants: d.participants,
      ...common,
    });

    await prisma.terminationDocument.create({
      data: {
        employeeId: d.employeeId,
        type: "HEARING_INVITATION",
        content: html,
        reason: summary,
        hearingDate: d.hearingDate ? new Date(d.hearingDate) : null,
      },
    });

    if (isStoreManager(me)) {
      await notifyOwner({
        type: "HEARING_ISSUED",
        title: "הונפקה הזמנה לשימוע",
        body: `${me.name} הנפיק/ה הזמנה לשימוע עבור ${employee.firstName} ${employee.lastName}.`,
        link: `/employees/${d.employeeId}`,
        actorName: me.name,
        companyId: me.companyId,
      });
    }

    return NextResponse.json({ type: d.docType, title, html });
  }

  // מכתב סיום העסקה (רגיל או כדין מתפטר/ת).
  const resignation = d.docType === "TERMINATION_RESIGNATION";
  const { title, html, noticeDays, lastWorkingDay } = generateTerminationLetter({
    employee: employeeInfo,
    hearingAttended: d.hearingAttended,
    resignation,
    ...common,
  });

  await prisma.$transaction([
    prisma.terminationDocument.create({
      data: {
        employeeId: d.employeeId,
        type: resignation ? "TERMINATION_RESIGNATION" : "TERMINATION_LETTER",
        content: html,
        reason: summary,
        noticeDays,
        lastWorkingDay,
      },
    }),
    prisma.employee.update({
      where: { id: d.employeeId },
      data: { status: "NOTICE_PERIOD", endDate: lastWorkingDay },
    }),
  ]);

  if (isStoreManager(me)) {
    await notifyOwner({
      type: "TERMINATION_ISSUED",
      title: "הונפק מכתב סיום העסקה",
      body: `${me.name} הנפיק/ה ${resignation ? "מכתב סיום העסקה (כדין מתפטר/ת)" : "מכתב פיטורין"} עבור ${employee.firstName} ${employee.lastName}.`,
      link: `/employees/${d.employeeId}`,
      actorName: me.name,
      companyId: me.companyId,
    });
  }

  return NextResponse.json({
    type: d.docType,
    title,
    html,
    noticeDays,
    lastWorkingDay: lastWorkingDay.toISOString(),
  });
}
