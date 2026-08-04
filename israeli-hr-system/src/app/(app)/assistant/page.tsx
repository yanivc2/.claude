import { AssistantChat } from "@/components/AssistantChat";

export const metadata = { title: "עוזר המערכת" };
export const dynamic = "force-dynamic";

export default function AssistantPage() {
  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
          עוזר המערכת
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          שאלות על עובדים ונתונים (ותק, הודעה מוקדמת, משימות) והדרכה על השימוש במערכת — בשפה חופשית.
        </p>
      </header>
      <AssistantChat />
    </div>
  );
}
