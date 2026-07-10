import { calculateNoticePeriod, lastWorkingDay } from "./termination";

// ─────────────────────────────────────────────────────────────────────────
// מחולל מסמכים משפטיים לתהליך סיום העסקה:
//   • הזמנה לשימוע
//   • מכתב סיום העסקה / פיטורין (כולל חישוב הודעה מוקדמת)
// המסמכים נוצרים כ-HTML בעברית עם פריסת RTL, מוכנים להדפסה / PDF.
// ─────────────────────────────────────────────────────────────────────────

export interface EmployeeInfo {
  firstName: string;
  lastName: string;
  nationalId: string;
  jobTitle?: string | null;
  department?: string | null;
  startDate: Date;
}

const dateFmt = new Intl.DateTimeFormat("he-IL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function wrapDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: Assistant, Arial, sans-serif; direction: rtl; line-height: 1.8; padding: 40px; color: #111; }
    h1 { font-size: 20px; text-align: center; }
    .meta { margin: 24px 0; }
    .sign { margin-top: 60px; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export interface HearingInvitationInput {
  employee: EmployeeInfo;
  hearingDate: Date;
  reason: string;
  location?: string;
}

export function generateHearingInvitation(input: HearingInvitationInput): {
  title: string;
  html: string;
} {
  const { employee, hearingDate, reason, location } = input;
  const fullName = `${employee.firstName} ${employee.lastName}`;
  const title = "הזמנה לשימוע";

  const body = `
  <h1>הזמנה לשימוע לפני סיום העסקה</h1>
  <p class="meta">תאריך: ${dateFmt.format(new Date())}</p>
  <p>לכבוד ${fullName}, ת.ז. ${employee.nationalId}${
    employee.jobTitle ? `, ${employee.jobTitle}` : ""
  }${employee.department ? `, מחלקת ${employee.department}` : ""},</p>

  <p>הרינו להזמינך לשימוע שבמסגרתו תינתן לך הזדמנות להשמיע את טענותיך בטרם תתקבל
  החלטה בעניין המשך העסקתך.</p>

  <p><strong>הנימוקים לשקילת סיום ההעסקה:</strong><br/>${reason}</p>

  <p><strong>מועד השימוע:</strong> ${dateFmt.format(hearingDate)}${
    location ? `<br/><strong>מקום:</strong> ${location}` : ""
  }</p>

  <p>הנך רשאי/ת להגיע לשימוע בליווי נציג מטעמך, ולהעלות טענותיך בכתב או בעל פה.
  ההחלטה הסופית תתקבל לאחר שקילת מלוא טענותיך בלב פתוח ובנפש חפצה.</p>

  <div class="sign">
    <p>בכבוד רב,<br/>מחלקת משאבי אנוש</p>
  </div>`;

  return { title, html: wrapDocument(title, body) };
}

export interface TerminationLetterInput {
  employee: EmployeeInfo;
  reason: string;
  noticeStartDate?: Date; // מועד תחילת ההודעה המוקדמת (ברירת מחדל: היום)
}

export function generateTerminationLetter(input: TerminationLetterInput): {
  title: string;
  html: string;
  noticeDays: number;
  lastWorkingDay: Date;
} {
  const { employee, reason } = input;
  const noticeStart = input.noticeStartDate ?? new Date();
  const fullName = `${employee.firstName} ${employee.lastName}`;
  const title = "מכתב סיום העסקה";

  // חישוב אוטומטי של ההודעה המוקדמת על סמך מועד תחילת העבודה.
  const notice = calculateNoticePeriod(employee.startDate, noticeStart);
  const lastDay = lastWorkingDay(noticeStart, notice.noticeDays);

  const body = `
  <h1>הודעה על סיום העסקה</h1>
  <p class="meta">תאריך: ${dateFmt.format(new Date())}</p>
  <p>לכבוד ${fullName}, ת.ז. ${employee.nationalId},</p>

  <p>בהמשך לשימוע שנערך בעניינך ולאחר שקילת טענותיך, הרינו להודיעך על סיום
  העסקתך בחברה.</p>

  <p><strong>נימוקי ההחלטה:</strong><br/>${reason}</p>

  <p><strong>תקופת הודעה מוקדמת:</strong> ${notice.noticeDays} ימים.<br/>
  <em>${notice.explanation}</em></p>

  <p><strong>מועד תחילת ההודעה המוקדמת:</strong> ${dateFmt.format(noticeStart)}<br/>
  <strong>יום העבודה האחרון:</strong> ${dateFmt.format(lastDay)}</p>

  <p>עם סיום ההעסקה תהיה זכאי/ת לגמר חשבון הכולל את כל התשלומים המגיעים לך על פי
  דין, לרבות פדיון חופשה, פיצויי פיטורים (ככל שחלים) ותלושי שכר סופיים.</p>

  <div class="sign">
    <p>בכבוד רב,<br/>מחלקת משאבי אנוש</p>
  </div>`;

  return {
    title,
    html: wrapDocument(title, body),
    noticeDays: notice.noticeDays,
    lastWorkingDay: lastDay,
  };
}
