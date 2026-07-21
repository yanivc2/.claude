import { z } from "zod";
import { prisma } from "./prisma";
import { scheduleRetentionSurveys } from "./retention";
import { schedulePensionTask } from "./pension";

// ─────────────────────────────────────────────────────────────────────────
// לוגיקה משותפת לקליטת עובד. משמשת גם את מסלול ה-HR הידני (/api/onboarding)
// וגם את מסלול הפורטל הציבורי (/api/onboard/[token]) — כדי לשמור על מקור אמת
// אחד לוולידציה וליצירת הרשומות.
// ─────────────────────────────────────────────────────────────────────────

const attachment = z
  .object({ fileName: z.string(), mimeType: z.string(), data: z.string() })
  .nullable();

export const onboardingSchema = z.object({
  // פרטים אישיים
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  nationalId: z.string().min(5),
  email: z.string().email(),
  phone: z.string().optional().default(""),
  address: z.string().optional().default(""),
  birthDate: z.string().optional().nullable(),
  // פרטי העסקה
  startDate: z.string(),
  jobTitle: z.string().optional().default(""),
  department: z.string().optional().default(""),
  monthlySalary: z.number().nullable(),
  hourlySalary: z.number().nullable().optional(),
  // זמינות: מפתח-יום → רשימת מפתחות-משמרת
  availability: z.record(z.array(z.string())).optional().nullable(),
  hasActivePension: z.boolean().optional().default(false),
  // טופס 101
  taxYear: z.number(),
  maritalStatus: z.string(),
  numberOfChildren: z.number(),
  isResidentOfIsrael: z.boolean(),
  hasOtherIncome: z.boolean(),
  requestsCredits: z.boolean(),
  // מסמכים וחתימות
  idAttachment: attachment,
  // הסכם העבודה מגיע מההזמנה (מוזרק בצד השרת), לא מהטופס — לכן אופציונלי.
  contractAttachment: attachment.optional(),
  contractSignature: z.string(),
  form101Signature: z.string().nullable(),
  // אישור מדיניות פרטיות ע"י העובד (בפורטל).
  // privacyAccepted=true משמעו שכל אישורי החובה סומנו (תאימות לאחור לשער הקיים).
  privacyAccepted: z.boolean().optional(),
  // גרסת המדיניות שאושרה, ומפת האישורים הפרטנית (חובה + רשות).
  privacyPolicyVersion: z.string().optional(),
  privacyConsents: z.record(z.boolean()).optional(),
  // שם החברה המעסיקה — מוזרק בצד השרת מתוך ההזמנה, לא נמסר ע"י הלקוח.
  privacyCompanyName: z.string().optional(),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;

// יוצר עובד מלא (עובד + טופס 101 + מסמכים + חתימות) בטרנזקציה אחת,
// ומתזמן אוטומטית את סקרי השימור. מחזיר את מזהה העובד שנוצר.
export async function createEmployeeFromOnboarding(data: OnboardingInput): Promise<string> {
  const startDate = new Date(data.startDate);
  const birthDate = data.birthDate ? new Date(data.birthDate) : null;

  const employee = await prisma.$transaction(async (tx) => {
    const emp = await tx.employee.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        nationalId: data.nationalId,
        email: data.email,
        phone: data.phone || null,
        address: data.address || null,
        birthDate: birthDate && !isNaN(birthDate.getTime()) ? birthDate : null,
        startDate,
        jobTitle: data.jobTitle || null,
        department: data.department || null,
        monthlySalary: data.monthlySalary,
        hourlySalary: data.hourlySalary ?? null,
        availability:
          data.availability && Object.keys(data.availability).length ? data.availability : undefined,
        hasActivePension: data.hasActivePension,
        privacyAcceptedAt: data.privacyAccepted ? new Date() : null,
        privacyPolicyVersion: data.privacyAccepted ? data.privacyPolicyVersion ?? null : null,
        privacyCompanyName: data.privacyAccepted ? data.privacyCompanyName ?? null : null,
        privacyConsents:
          data.privacyAccepted && data.privacyConsents ? data.privacyConsents : undefined,
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

    // הסכם עבודה שהועלה (אם קיים) — נשמר כמסמך מסוג CONTRACT.
    if (data.contractAttachment) {
      await tx.employeeDocument.create({
        data: {
          employeeId: emp.id,
          type: "CONTRACT",
          fileName: data.contractAttachment.fileName,
          fileUrl: data.contractAttachment.data,
          mimeType: data.contractAttachment.mimeType,
        },
      });
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

  // תזמון אוטומטי של סקרי שביעות רצון ל-3/15/30 ימים.
  await scheduleRetentionSurveys(employee.id, startDate);

  // תזמון פתיחת תיק פנסיה לפי החוק (3 חודשים עם הסדר קיים, 6 חודשים בלעדיו).
  await schedulePensionTask(employee.id, startDate, data.hasActivePension);

  return employee.id;
}

// הודעת שגיאה ידידותית לכפילות ת.ז/דוא״ל.
export function onboardingErrorMessage(err: unknown): string {
  return err instanceof Error && err.message.includes("Unique")
    ? "עובד עם ת.ז או דוא״ל זהים כבר קיים במערכת."
    : "שגיאה בשמירת נתוני הקליטה.";
}

// תוויות עבריות לשדות הטופס — לבניית הודעת שגיאה מובנת (איזה שדה נכשל).
const FIELD_LABELS: Record<string, string> = {
  firstName: "שם פרטי",
  lastName: "שם משפחה",
  nationalId: "תעודת זהות",
  email: "דוא״ל",
  phone: "טלפון",
  address: "כתובת",
  birthDate: "תאריך לידה",
  startDate: "מועד תחילת עבודה",
  jobTitle: "תפקיד",
  monthlySalary: "שכר חודשי",
  hourlySalary: "שכר שעתי",
  availability: "זמינות",
  taxYear: "שנת המס",
  maritalStatus: "מצב משפחתי",
  numberOfChildren: "מספר ילדים",
  isResidentOfIsrael: "תושב/ת ישראל",
  hasOtherIncome: "הכנסה נוספת",
  requestsCredits: "נקודות זיכוי",
  idAttachment: "ספח תעודת זהות",
  contractSignature: "חתימה על הסכם העבודה",
  form101Signature: "חתימה על טופס 101",
};

// בונה הודעה עברית קריאה מכשל ולידציה של Zod: מפרט אילו שדות שגויים,
// כדי שהעובד יידע מה לתקן במקום לראות "נתונים שגויים" כללי.
export function onboardingValidationMessage(fieldErrors: Record<string, string[] | undefined>): string {
  const fields = Object.keys(fieldErrors)
    .filter((k) => (fieldErrors[k]?.length ?? 0) > 0)
    .map((k) => FIELD_LABELS[k] ?? k);
  if (fields.length === 0) return "חלק מהשדות שגויים או חסרים. אנא בדוק/י את הטופס.";
  return `יש לבדוק ולתקן את השדות הבאים: ${fields.join(", ")}.`;
}
