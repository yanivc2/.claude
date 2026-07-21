import { prisma } from "./prisma";
import type { SurveyMilestone } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────
// מודול שימור: תזמון סקרי שביעות רצון (Pulse Surveys) ל-3/15/30 ימים
// ממועד תחילת העבודה, ותזמון פגישות חתך למנהל הישיר.
// הערה: שמות ערכי ה-enum (DAY_30/60/90) נשמרו כדי להימנע ממיגרציית מסד;
// המרווחים בפועל מוגדרים כאן ומייצגים 3/15/30 ימים.
// ─────────────────────────────────────────────────────────────────────────

const MILESTONE_DAYS: Record<SurveyMilestone, number> = {
  DAY_30: 3,
  DAY_60: 15,
  DAY_90: 30,
};

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// יצירת שלושת הסקרים המתוזמנים עבור עובד חדש. נקרא בסיום הקליטה.
export async function scheduleRetentionSurveys(employeeId: string, startDate: Date) {
  const milestones = Object.keys(MILESTONE_DAYS) as SurveyMilestone[];

  await prisma.$transaction(
    milestones.map((milestone) =>
      prisma.retentionSurvey.upsert({
        where: { employeeId_milestone: { employeeId, milestone } },
        create: {
          employeeId,
          milestone,
          scheduledFor: addDays(startDate, MILESTONE_DAYS[milestone]),
          status: "SCHEDULED",
        },
        update: {},
      }),
    ),
  );
}

export interface DueSurvey {
  id: string;
  employeeName: string;
  managerEmail: string | null;
  milestone: SurveyMilestone;
}

// שליפת הסקרים שהגיע מועד שליחתם (נקרא מה-cron היומי).
export async function processDueSurveys(): Promise<DueSurvey[]> {
  const due = await prisma.retentionSurvey.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: new Date() } },
    include: { employee: { include: { manager: true } } },
  });

  const processed: DueSurvey[] = [];

  for (const survey of due) {
    // סימון כנשלח. כאן ניתן לשלב שליחת מייל בפועל וזימון פגישת יומן למנהל.
    await prisma.retentionSurvey.update({
      where: { id: survey.id },
      data: { status: "SENT", sentAt: new Date() },
    });

    processed.push({
      id: survey.id,
      employeeName: `${survey.employee.firstName} ${survey.employee.lastName}`,
      managerEmail: survey.employee.manager?.email ?? null,
      milestone: survey.milestone,
    });
  }

  return processed;
}
