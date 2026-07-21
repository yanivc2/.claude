import { prisma } from "@/lib/prisma";
import { TerminationForm } from "@/components/TerminationForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "סיום העסקה" };

export default async function TerminationPage() {
  const employees = await prisma.employee
    .findMany({
      where: { status: { in: ["ACTIVE", "NOTICE_PERIOD"] } },
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
        <h1 className="text-2xl font-bold text-slate-800">סיום העסקה</h1>
        <p className="mt-1 text-sm text-slate-500">
          הפקת הזמנה לשימוע ומכתב פיטורין. ימי ההודעה המוקדמת מחושבים אוטומטית לפי
          חוק הודעה מוקדמת ומועד תחילת העבודה.
        </p>
      </header>
      {options.length > 0 ? (
        <TerminationForm employees={options} />
      ) : (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          אין עובדים פעילים במערכת. יש לקלוט עובד תחילה.
        </p>
      )}
    </div>
  );
}
