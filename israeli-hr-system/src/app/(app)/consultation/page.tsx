import { ChatConsultation } from "@/components/ChatConsultation";

export const metadata = { title: "יועץ לזכויות עובדים" };

export default function ConsultationPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-slate-800 dark:text-slate-100">יועץ לזכויות עובדים</h1>
        <p className="mt-2 text-base text-slate-500 dark:text-slate-400">
          יועץ מבוסס בינה מלאכותית לזכויות וחוקי עבודה בישראל, המסתמך על בסיס ידע משפטי
          מבוסס &ldquo;כל זכות&rdquo;. המידע כללי בלבד ואינו תחליף לייעוץ משפטי פרטני.
        </p>
      </header>
      <ChatConsultation />
    </div>
  );
}
