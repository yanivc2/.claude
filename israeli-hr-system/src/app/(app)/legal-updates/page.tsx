import { Suspense } from "react";
import { LegalUpdatesFeed } from "@/components/LegalUpdatesFeed";

export const dynamic = "force-dynamic";
export const metadata = { title: "עדכוני חקיקה" };

export default function LegalUpdatesPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">עדכוני חקיקה</h1>
        <p className="mt-1 text-sm text-slate-500">
          עדכוני חקיקה ופסיקה בדיני עבודה, נמשכים אוטומטית אחת לשבוע ממקורות ציבוריים.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-slate-400">טוען עדכונים...</p>}>
        <LegalUpdatesFeed />
      </Suspense>
    </div>
  );
}
