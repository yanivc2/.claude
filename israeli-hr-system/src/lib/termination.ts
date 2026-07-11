// ─────────────────────────────────────────────────────────────────────────
// חישוב ימי הודעה מוקדמת לפי חוק הודעה מוקדמת לפיטורים ולהתפטרות, התשס"א-2001.
//
// לעובד במשכורת (חודשי):
//   • חודשים 1-6:   יום אחד לכל חודש עבודה.
//   • חודשים 7-12:  6 ימים + 2.5 ימים לכל חודש החל מהחודש השביעי.
//   • שנה ומעלה:    חודש קלנדרי מלא (מיוצג כ-30 ימים).
//
// לעובד בשכר שעתי/יומי החישוב שונה — כאן ממומש המסלול החודשי הנפוץ.
// זהו כלי עזר; יש לאמת מול ייעוץ משפטי לפני שימוש מחייב.
// ─────────────────────────────────────────────────────────────────────────

export interface NoticeCalculation {
  monthsEmployed: number;
  noticeDays: number;
  explanation: string;
}

// מספר החודשים המלאים בין שני תאריכים.
export function monthsBetween(start: Date, end: Date): number {
  let months = (end.getFullYear() - start.getFullYear()) * 12;
  months += end.getMonth() - start.getMonth();
  // אם היום בחודש הסיום קטן מיום ההתחלה, החודש הנוכחי לא הושלם.
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

export function calculateNoticePeriod(startDate: Date, asOf: Date = new Date()): NoticeCalculation {
  const months = monthsBetween(startDate, asOf);

  let noticeDays: number;
  let explanation: string;

  if (months >= 12) {
    noticeDays = 30;
    explanation = "ותק של שנה ומעלה — חודש הודעה מוקדמת (30 ימים).";
  } else if (months >= 6) {
    // 6 ימים בסיס + 2.5 ימים לכל חודש מהחודש השביעי (months - 6 חודשים).
    noticeDays = Math.round(6 + (months - 6) * 2.5);
    explanation = `ותק של ${months} חודשים — 6 ימים בסיס בתוספת 2.5 ימים לכל חודש מהחודש השביעי (סה"כ ${noticeDays} ימים).`;
  } else {
    noticeDays = months;
    explanation = `ותק של ${months} חודשים — יום הודעה מוקדמת לכל חודש עבודה (${noticeDays} ימים).`;
  }

  return { monthsEmployed: months, noticeDays, explanation };
}

// חישוב היום האחרון בעבודה בהתאם לימי ההודעה המוקדמת.
export function lastWorkingDay(noticeStart: Date, noticeDays: number): Date {
  const d = new Date(noticeStart);
  d.setDate(d.getDate() + noticeDays);
  return d;
}
