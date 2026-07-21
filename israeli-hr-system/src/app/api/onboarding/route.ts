import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { scheduleRetentionSurveys } from "@/lib/retention";

const schema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  nationalId: z.string().min(5),
  email: z.string().email(),
  phone: z.string().optional().default(""),
  address: z.string().optional().default(""),
  startDate: z.string(),
  jobTitle: z.string().optional().default(""),
  department: z.string().optional().default(""),
  monthlySalary: z.number().nullable(),
  taxYear: z.number(),
  maritalStatus: z.string(),
  numberOfChildren: z.number(),
  isResidentOfIsrael: z.boolean(),
  hasOtherIncome: z.boolean(),
  requestsCredits: z.boolean(),
  idAttachment: z
    .object({ fileName: z.string(), mimeType: z.string(), data: z.string() })
    .nullable(),
  contractSignature: z.string(),
  form101Signature: z.string().nullable(),
});

// POST /api/onboarding — יצירת עובד, טופס 101, מסמכים, חתימות ותזמון סקרים.
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "נתונים שגויים", details: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  const startDate = new Date(data.startDate);

  try {
    const employee = await prisma.$transaction(async (tx) => {
      const emp = await tx.employee.create({
        data: {
          firstName: data.firstName,
          lastName: data.lastName,
          nationalId: data.nationalId,
          email: data.email,
          phone: data.phone || null,
          address: data.address || null,
          startDate,
          jobTitle: data.jobTitle || null,
          department: data.department || null,
          monthlySalary: data.monthlySalary,
          status: "ACTIVE",
        },
      });

      // ספח ת.ז (אם הועלה) — נשמר כמסמך.
      let idDocId: string | undefined;
      if (data.idAttachment) {
        const doc = await tx.employeeDocument.create({
          data: {
            employeeId: emp.id,
            type: "ID_CARD",
            fileName: data.idAttachment.fileName,
            fileUrl: data.idAttachment.data, // בפרודקשן: העלאה ל-object storage וקבלת URL
            mimeType: data.idAttachment.mimeType,
          },
        });
        idDocId = doc.id;
      }

      // טופס 101.
      await tx.form101.create({
        data: {
          employeeId: emp.id,
          taxYear: data.taxYear,
          maritalStatus: data.maritalStatus,
          numberOfChildren: data.numberOfChildren,
          isResidentOfIsrael: data.isResidentOfIsrael,
          hasOtherIncome: data.hasOtherIncome,
          requestsCredits: data.requestsCredits,
          idAttachmentId: idDocId,
          signedAt: data.form101Signature ? new Date() : null,
        },
      });

      // חתימה על הסכם העבודה (חובה).
      await tx.signature.create({
        data: { employeeId: emp.id, context: "CONTRACT", imageData: data.contractSignature },
      });

      // חתימה על טופס 101 (אופציונלי).
      if (data.form101Signature) {
        await tx.signature.create({
          data: { employeeId: emp.id, context: "FORM_101", imageData: data.form101Signature },
        });
      }

      return emp;
    });

    // תזמון אוטומטי של סקרי שביעות רצון ל-30/60/90 ימים.
    await scheduleRetentionSurveys(employee.id, startDate);

    return NextResponse.json({ id: employee.id, status: "ok" }, { status: 201 });
  } catch (err) {
    const message =
      err instanceof Error && err.message.includes("Unique")
        ? "עובד עם ת.ז או דוא״ל זהים כבר קיים במערכת."
        : "שגיאה בשמירת נתוני הקליטה.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
