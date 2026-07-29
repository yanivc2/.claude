// שליחת מייל דרך Resend (REST API). דורש RESEND_API_KEY.
// אם לא מוגדר — מחזיר false והקורא יטפל בנפילה בחן.

export interface EmailAttachment {
  filename: string;
  content: string; // base64 (ללא קידומת data:)
}

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const from = process.env.EMAIL_FROM || "מערכת משאבי אנוש <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        ...(opts.attachments && opts.attachments.length ? { attachments: opts.attachments } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
