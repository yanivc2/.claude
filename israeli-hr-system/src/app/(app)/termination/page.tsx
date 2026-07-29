import { Users } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { TerminationForm } from "@/components/TerminationForm";
import { EmptyState } from "@/components/EmptyState";
import { currentAdmin } from "@/lib/session";
import { employeeScope, roleOf } from "@/lib/rbac";
import { NoAccessNotice } from "@/components/NoAccessNotice";

export const dynamic = "force-dynamic";
export const metadata = { title: "סיום העסקה" };

export default async function TerminationPage() {
  const me = await currentAdmin();
  // שלב 1: הנפקת מסמכי סיום — בעלים/מזכירה בלבד. (יורחב למנהל חנות בשלב הבא.)
  if (me && roleOf(me) === "STORE_MANAGER") {
    return <NoAccessNotice message="הנפקת מסמכי סיום העסקה תתאפשר בקרוב עבור מנהל חנות. בשלב זה הפעולה מוגבלת לבעלים ולמזכירה." />;
  }
  const employees = await prisma.employee
    .findMany({
      where: { status: { in: ["ACTIVE", "NOTICE_PERIOD"] }, ...(me ? employeeScope(me) : { id: "__none__" }) },
      orderBy: { lastName: "asc" },
      include: { onboardingInvite: { select: { companyName: true } } },
    })
    .catch(() => []);

  const options = employees.map((e) => ({
    id: e.id,
    name: `${e.firstName} ${e.lastName}`,
    startDate: e.startDate.toISOString(),
    companyName: e.onboardingInvite?.companyName ?? "",
  }));

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">סיום העסקה</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          הפקת הזמנה לשימוע ומכתב פיטורין. ימי ההודעה המוקדמת מחושבים אוטומטית לפי
          חוק הודעה מוקדמת ומועד תחילת העבודה.
        </p>
      </header>
      {options.length > 0 ? (
        <TerminationForm employees={options} />
      ) : (
        <EmptyState
          icon={Users}
          title="אין עובדים פעילים"
          subtitle="יש לקלוט עובד תחילה כדי להפיק מסמכי סיום העסקה."
        />
      )}
    </div>
  );
}
