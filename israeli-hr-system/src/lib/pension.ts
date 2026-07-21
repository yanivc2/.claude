import { prisma } from "./prisma";

// ─────────────────────────────────────────────────────────────────────────
// תזמון פתיחת תיק פנסיה לפי צו ההרחבה לביטוח פנסיוני מקיף במשק:
//   • עובד שהגיע ללא הסדר פנסיוני קודם — זכאי לביטוח פנסיוני לאחר 6 חודשי
//     עבודה; יש לפתוח תיק ולהתחיל הפרשות בתום 6 החודשים.
//   • עובד שהגיע עם הסדר פנסיוני פעיל — זכאי מהיום הראשון; ההפרשות מתבצעות
//     לא יאוחר מ-3 חודשי עבודה, רטרואקטיבית ליום תחילת העבודה.
// ─────────────────────────────────────────────────────────────────────────

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export interface PensionSchedule {
  dueDate: Date;
  basis: string;
  hadPriorArrangement: boolean;
}

// מחשב את מועד היעד וההסבר לפי מצב ההסדר הפנסיוני של העובד.
export function computePensionSchedule(startDate: Date, hasActivePension: boolean): PensionSchedule {
  if (hasActivePension) {
    return {
      dueDate: addMonths(startDate, 3),
      hadPriorArrangement: true,
      basis:
        "עובד שהגיע עם הסדר פנסיוני פעיל — זכאי מהיום הראשון. יש להפעיל תיק ולבצע " +
        "הפרשות לא יאוחר מ-3 חודשי עבודה, רטרואקטיבית ליום תחילת העבודה.",
    };
  }
  return {
    dueDate: addMonths(startDate, 6),
    hadPriorArrangement: false,
    basis:
      "עובד ללא הסדר פנסיוני קודם — זכאות לביטוח פנסיוני לאחר 6 חודשי עבודה. " +
      "יש לפתוח תיק ולהתחיל הפרשות בתום 6 החודשים.",
  };
}

// יוצר/מעדכן משימת פנסיה לעובד. נקרא בסיום הקליטה.
export async function schedulePensionTask(
  employeeId: string,
  startDate: Date,
  hasActivePension: boolean,
) {
  const s = computePensionSchedule(startDate, hasActivePension);
  await prisma.pensionTask.upsert({
    where: { employeeId },
    create: {
      employeeId,
      dueDate: s.dueDate,
      basis: s.basis,
      hadPriorArrangement: s.hadPriorArrangement,
      status: "PENDING",
    },
    update: {
      dueDate: s.dueDate,
      basis: s.basis,
      hadPriorArrangement: s.hadPriorArrangement,
    },
  });
}
