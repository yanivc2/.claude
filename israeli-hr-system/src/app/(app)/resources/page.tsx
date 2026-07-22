import { ResourcesManager } from "@/components/ResourcesManager";

export const metadata = { title: "מסמכים ונהלים" };

export default function ResourcesPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800">מסמכים ונהלים</h1>
        <p className="mt-1 text-sm text-slate-500">
          ספריית משאבים לצוות: נהלי עבודה, מסמכים, וסרטוני הסברה (קובץ או קישור).
        </p>
      </header>
      <ResourcesManager />
    </div>
  );
}
