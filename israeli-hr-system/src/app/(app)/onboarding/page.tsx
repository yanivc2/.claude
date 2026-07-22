import { OnboardingForm } from "@/components/OnboardingForm";
import { InviteGenerator } from "@/components/InviteGenerator";

export const metadata = { title: "קליטת עובד" };

export default function OnboardingPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800">קליטת עובד</h1>
        <p className="mt-1 text-sm text-slate-500">
          שלח/י לעובד קישור למילוי עצמי, או מלא/י את הטופס ידנית: טופס 101, העלאת ספח ת.ז
          וחתימה על הסכם העבודה.
        </p>
      </header>

      {/* שליחת קישור קליטה עצמית לעובד */}
      <InviteGenerator />

      {/* קליטה ידנית ע"י מנהל HR */}
      <div className="mb-4 mt-8 border-t border-slate-200 pt-6">
        <h2 className="text-lg font-bold text-slate-800">קליטה ידנית</h2>
        <p className="mt-1 text-sm text-slate-500">מילוי הטופס ישירות ע"י משאבי אנוש.</p>
      </div>
      <OnboardingForm />
    </div>
  );
}
