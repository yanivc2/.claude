import { OnboardingForm } from "@/components/OnboardingForm";
import { InviteGenerator } from "@/components/InviteGenerator";
import { currentAdmin } from "@/lib/session";
import { roleOf } from "@/lib/rbac";
import { NoAccessNotice } from "@/components/NoAccessNotice";

export const metadata = { title: "קליטת עובד" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const me = await currentAdmin();
  // קליטת עובד — פעולת כתיבה. מנהל חנות (צפייה בלבד) חסום.
  if (me && roleOf(me) === "STORE_MANAGER") {
    return <NoAccessNotice message="קליטת עובדים מוגבלת לבעלים ולמזכירה. מנהל חנות רשאי לצפות בנתונים בלבד." />;
  }
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">קליטת עובד</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          שלח/י לעובד קישור למילוי עצמי, או מלא/י את הטופס ידנית: טופס 101, העלאת ספח ת.ז
          וחתימה על הסכם העבודה.
        </p>
      </header>

      {/* שליחת קישור קליטה עצמית לעובד */}
      <InviteGenerator />

      {/* מפריד "או" בין קליטה עצמית לקליטה ידנית */}
      <div className="my-8 flex items-center gap-4">
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          או קליטה ידנית
        </span>
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
      </div>
      <div className="mb-4">
        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">קליטה ידנית</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          מילוי הטופס ישירות ע&quot;י משאבי אנוש.
        </p>
      </div>
      <OnboardingForm hideSignatures />
    </div>
  );
}
