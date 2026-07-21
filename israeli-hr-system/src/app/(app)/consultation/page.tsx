import { ChatConsultation } from "@/components/ChatConsultation";

export const metadata = { title: "התייעצות חוקים וזכויות" };

export default function ConsultationPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">התייעצות חוקים וזכויות</h1>
        <p className="mt-1 text-sm text-slate-500">
          צ'אטבוט מבוסס בינה מלאכותית (RAG) המסתמך אך ורק על בסיס הידע המשפטי המעודכן.
          התשובות אינן מהוות תחליף לייעוץ משפטי פרטני.
        </p>
      </header>
      <ChatConsultation />
    </div>
  );
}
