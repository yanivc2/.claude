import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireWriter, canAccessEmployeeRecord } from "@/lib/rbac";
import { sendEmail, emailConfigured } from "@/lib/email";

const schema = z.object({ contactId: z.string().optional(), email: z.string().email().optional() });

// ממיר data URL ל-base64 נקי (ללא הקידומת) עבור צירוף למייל.
function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

// POST /api/documents/[id]/send — שליחת מסמך במייל (עם צירוף) לאיש קשר/כתובת.
// בעלים/מזכירה בלבד. דורש הגדרת RESEND_API_KEY.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await requireWriter(req);
  if (!me) return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });

  if (!emailConfigured()) {
    return NextResponse.json(
      { error: "שליחת מייל אינה מוגדרת בשרת (חסר RESEND_API_KEY). ניתן להשתמש בוואטסאפ או בהורדה." },
      { status: 400 },
    );
  }

  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "נתונים שגויים" }, { status: 400 });

  const doc = await prisma.employeeDocument.findUnique({
    where: { id },
    include: { employee: { select: { firstName: true, lastName: true, companyId: true } } },
  });
  if (!doc) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });
  if (!canAccessEmployeeRecord(me, doc.employee.companyId)) {
    return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });
  }

  // יעד: איש קשר לפי מזהה, או כתובת ישירה.
  let to = parsed.data.email ?? "";
  let contactName = "";
  if (parsed.data.contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: parsed.data.contactId } });
    if (!contact?.email) {
      return NextResponse.json({ error: "לאיש הקשר אין כתובת דוא״ל" }, { status: 400 });
    }
    to = contact.email;
    contactName = contact.name;
  }
  if (!to) return NextResponse.json({ error: "לא נבחר נמען" }, { status: 400 });

  const employeeName = `${doc.employee.firstName} ${doc.employee.lastName}`;
  const ok = await sendEmail({
    to,
    subject: `מסמך פנסיה — ${employeeName}`,
    html:
      `<div dir="rtl" style="font-family:Arial,sans-serif">` +
      `<p>שלום${contactName ? " " + contactName : ""},</p>` +
      `<p>מצורף מסמך עבור העובד/ת <strong>${employeeName}</strong>: ${doc.fileName}.</p>` +
      `<p>בברכה,<br/>מערכת משאבי אנוש</p></div>`,
    attachments: [{ filename: doc.fileName, content: base64FromDataUrl(doc.fileUrl) }],
  });

  if (!ok) return NextResponse.json({ error: "שליחת המייל נכשלה" }, { status: 502 });
  return NextResponse.json({ status: "ok" });
}
