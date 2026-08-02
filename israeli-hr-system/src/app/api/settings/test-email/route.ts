import { NextResponse } from "next/server";
import { requireAdmin, roleOf } from "@/lib/rbac";
import { sendEmail, emailConfigured } from "@/lib/email";

// POST /api/settings/test-email — שולח מייל ניסיון לכתובת של המשתמש המחובר,
// לבדיקת חיבור Resend. בעלים בלבד.
export async function POST(req: Request) {
  const me = await requireAdmin(req);
  if (!me || roleOf(me) !== "OWNER") {
    return NextResponse.json({ error: "אין הרשאה" }, { status: 403 });
  }
  if (!emailConfigured()) {
    return NextResponse.json(
      { error: "שליחת מייל אינה מוגדרת (חסר RESEND_API_KEY ב-Vercel). לאחר ההוספה יש לבצע Redeploy." },
      { status: 400 },
    );
  }
  if (!me.email) {
    return NextResponse.json({ error: "לחשבון שלך אין כתובת דוא״ל." }, { status: 400 });
  }

  const ok = await sendEmail({
    to: me.email,
    subject: "בדיקת מייל — מערכת משאבי אנוש",
    html:
      `<div dir="rtl" style="font-family:Arial,sans-serif">` +
      `<p>שלום ${me.name},</p>` +
      `<p>זהו מייל ניסיון. אם קיבלת אותו — חיבור שליחת המייל (Resend) פעיל ותקין ✅</p>` +
      `<p>בברכה,<br/>מערכת משאבי אנוש</p></div>`,
  });

  if (!ok) {
    return NextResponse.json(
      { error: "המפתח מוגדר אך השליחה נכשלה. ודא/י שהמפתח תקין, ושכתובת השולח (EMAIL_FROM) מותרת (בכתובת הבדיקה של Resend ניתן לשלוח רק לכתובת שאיתה נרשמת)." },
      { status: 502 },
    );
  }
  return NextResponse.json({ status: "ok", to: me.email });
}
