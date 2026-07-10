import { OnboardingForm } from "@/components/OnboardingForm";

export default function OnboardingPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">קליטת עובד</h1>
        <p className="mt-1 text-sm text-slate-500">
          תהליך קליטה דיגיטלי מלא: טופס 101, העלאת ספח ת.ז וחתימה על הסכם העבודה.
        </p>
      </header>
      <OnboardingForm />
    </div>
  );
}
