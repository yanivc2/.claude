import { calculateNoticePeriod, lastWorkingDay } from "./termination";

// ─────────────────────────────────────────────────────────────────────────
// מחולל מסמכים משפטיים לתהליך סיום העסקה:
//   • הזמנה לשיחת שימוע
//   • מכתב סיום העסקה / פיטורין (כולל חישוב הודעה מוקדמת)
//   • סיום העסקה כדין מתפטר/ת
// המסמכים נוצרים כ-HTML בעברית עם פריסת RTL, בפורמט מכתב רשמי, מוכנים
// להדפסה / PDF. המבנה תואם למכתבי חברה מקובלים (שם חברה, לכבוד, הנידון,
// נימוקים ממוספרים, וחתימת מנכ"ל).
// ─────────────────────────────────────────────────────────────────────────

export interface EmployeeInfo {
  firstName: string;
  lastName: string;
  nationalId: string;
  jobTitle?: string | null;
  department?: string | null;
  startDate: Date;
}

export interface ReasonItem {
  title: string;
  detail?: string;
}

export type Gender = "male" | "female";

const dateFmt = new Intl.DateTimeFormat("he-IL", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// בורר ניסוח לפי מגדר.
function gword(gender: Gender | undefined, male: string, female: string): string {
  return gender === "female" ? female : male;
}

function wrapDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>
    body { font-family: Assistant, Arial, sans-serif; direction: rtl; line-height: 1.9; padding: 40px; color: #111; }
    .datetop { text-align: left; font-size: 15px; margin-bottom: 8px; }
    .company { text-align: center; font-weight: 700; font-size: 20px; margin: 8px 0 24px; }
    .field { margin: 2px 0; }
    .greet { margin-top: 18px; }
    p { margin: 10px 0; }
    ol { padding-inline-start: 22px; margin: 8px 0; }
    ol li { margin: 4px 0; }
    .sign { margin-top: 56px; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

// כותרת המכתב: תאריך (שמאל למעלה) ושם החברה (במרכז).
function letterHeader(companyName: string | null | undefined): string {
  return `<div class="datetop">${dateFmt.format(new Date())}</div>
  ${companyName ? `<div class="company">${esc(companyName)}</div>` : ""}`;
}

// שורות "לכבוד" ו"הנידון".
function addressBlock(fullName: string, subject: string): string {
  return `<p class="field">לכבוד : ${esc(fullName)}</p>
  <p class="field">הנידון : ${esc(subject)}</p>`;
}

// חתימה: בכבוד רב, שם החותם, תפקידו.
function signoff(signerName?: string, signerTitle?: string): string {
  return `<div class="sign">
    <p>בכבוד רב,</p>
    ${signerName ? `<p>${esc(signerName)},</p>` : ""}
    ${signerTitle ? `<p>${esc(signerTitle)}.</p>` : ""}
  </div>`;
}

// נימוקים כרשימה ממוספרת (1, 2, 3...), עם פירוט אופציונלי לכל אחד.
function reasonsList(reasons: ReasonItem[] | undefined, notes?: string): string {
  let html = "";
  if (reasons && reasons.length) {
    html +=
      "<ol>" +
      reasons
        .map(
          (r) =>
            `<li>${esc(r.title)}${r.detail && r.detail.trim() ? ` — ${esc(r.detail.trim())}` : ""}.</li>`,
        )
        .join("") +
      "</ol>";
  }
  if (notes && notes.trim()) html += `<p>${esc(notes.trim())}</p>`;
  return html;
}

// ───────────────────────────── הזמנה לשימוע ─────────────────────────────

export interface HearingInvitationInput {
  employee: EmployeeInfo;
  hearingDate: Date;
  hearingTime?: string;
  location?: string;
  participants?: string;
  reasons?: ReasonItem[];
  notes?: string;
  companyName?: string | null;
  signerName?: string;
  signerTitle?: string;
  gender?: Gender;
}

export function generateHearingInvitation(input: HearingInvitationInput): {
  title: string;
  html: string;
} {
  const { employee, hearingDate, hearingTime, location, participants, reasons, notes, companyName, gender } =
    input;
  const fullName = `${employee.firstName} ${employee.lastName}`;
  const title = "הזמנה לשיחת שימוע";
  const co = companyName ? esc(companyName) : "";

  const body = `
  ${letterHeader(companyName)}
  ${addressBlock(fullName, "הזמנה לשיחת שימוע")}

  <p class="greet">${esc(employee.firstName)} שלום רב,</p>

  <p>הריני להודיע, כי בהמשך לשיחות שהתקיימו אתך, אנו שוקלים לסיים את העסקתך${
    co ? ` ב${co}` : ""
  } ומעוניינים להזמינך לשיחת שימוע בשל הנימוקים שלהלן:</p>

  ${reasonsList(reasons, notes)}

  <p>א: נוכח האמור, הנך ${gword(gender, "מוזמן", "מוזמנת")} לשיחת שימוע${
    participants ? ` – בה ${gword(gender, "ישתתף", "ישתתפו")} ${esc(participants)}` : ""
  }.</p>

  <p>ב: ${dateFmt.format(hearingDate)}${location ? ` ב${esc(location)}` : ""}${
    hearingTime ? ` בשעה ${esc(hearingTime)}` : ""
  }.</p>

  <p>לאחר קיום שיחת השימוע ולאחר שנשקול את דבריך בישיבה זו, תתקבל החלטה האם להמשיך
  את העסקתך${co ? ` בחברת ${co}` : ""}.</p>

  ${signoff(input.signerName, input.signerTitle)}`;

  return { title, html: wrapDocument(title, body) };
}

// ─────────────────────────── מכתב סיום העסקה ───────────────────────────

export interface TerminationLetterInput {
  employee: EmployeeInfo;
  reasons?: ReasonItem[];
  notes?: string;
  companyName?: string | null;
  signerName?: string;
  signerTitle?: string;
  gender?: Gender;
  hearingAttended?: boolean; // האם העובד התייצב לשימוע
  resignation?: boolean; // סיום כדין מתפטר/ת
  noticeStartDate?: Date;
}

export function generateTerminationLetter(input: TerminationLetterInput): {
  title: string;
  html: string;
  noticeDays: number;
  lastWorkingDay: Date;
} {
  const { employee, reasons, notes, companyName, gender, hearingAttended, resignation } = input;
  const noticeStart = input.noticeStartDate ?? new Date();
  const fullName = `${employee.firstName} ${employee.lastName}`;
  const co = companyName ? esc(companyName) : "";

  const notice = calculateNoticePeriod(employee.startDate, noticeStart);
  const lastDay = lastWorkingDay(noticeStart, notice.noticeDays);

  const subject = resignation ? "סיום העסקה כדין מתפטר/ת" : "סיום העסקה";
  const title = subject;

  const hearingRef = hearingAttended
    ? "בהמשך לשיחת השימוע שהתקיימה בנוכחותך ולאחר שקילת טענותיך"
    : "בהמשך לשיחת השימוע שהתקיימה ללא נוכחותך";

  const opener = resignation
    ? `<p>הריני להודיע, כי ${hearingRef}, הוחלט לסיים את העסקתך${
        co ? ` ב${co}` : ""
      } כדין ${gword(gender, "מתפטר", "מתפטרת")} בשל הנימוקים שלהלן:</p>`
    : `<p>הריני להודיע, כי ${hearingRef}, הוחלט לסיים את העסקתך${
        co ? ` ב${co}` : ""
      } בשל הנימוקים שלהלן:</p>`;

  const closing = resignation
    ? `<p>נוכח האמור, סיום עבודתך יכנס לתוקף בהתאם לחובה בדבר מתן הודעה מוקדמת, בתוך
       ${notice.noticeDays} ימים מיום זה (עד לתאריך ${dateFmt.format(
         lastDay,
       )}). הנך ${gword(gender, "מתבקש", "מתבקשת")} להגיע למשמרות בשעות הבוקר כפי שנהגת
       עד לרגע זה, על מנת למנוע נזק לפעילות ולמלא את תפקידך.</p>`
    : `<p><strong>תקופת הודעה מוקדמת:</strong> ${notice.noticeDays} ימים.<br/>
       <em>${notice.explanation}</em></p>
       <p><strong>מועד תחילת ההודעה המוקדמת:</strong> ${dateFmt.format(noticeStart)}<br/>
       <strong>יום העבודה האחרון:</strong> ${dateFmt.format(lastDay)}</p>
       <p>עם סיום ההעסקה תהיה ${gword(gender, "זכאי", "זכאית")} לגמר חשבון הכולל את כל
       התשלומים המגיעים לך על פי דין, לרבות פדיון חופשה, פיצויי פיטורים (ככל שחלים)
       ותלושי שכר סופיים.</p>`;

  const body = `
  ${letterHeader(companyName)}
  ${addressBlock(fullName, subject)}

  <p class="greet">${esc(employee.firstName)} שלום רב,</p>

  ${opener}

  ${reasonsList(reasons, notes)}

  ${closing}

  ${signoff(input.signerName, input.signerTitle)}`;

  return { title, html: wrapDocument(title, body), noticeDays: notice.noticeDays, lastWorkingDay: lastDay };
}
