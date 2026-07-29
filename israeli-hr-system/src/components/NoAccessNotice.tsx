import Link from "next/link";
import { Lock } from "lucide-react";

// הודעת "אין הרשאה" אחידה לעמודים שאינם זמינים לרמת ההרשאה הנוכחית.
export function NoAccessNotice({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
        <Lock size={26} />
      </span>
      <h1 className="mt-4 text-xl font-bold text-slate-800 dark:text-slate-100">אין הרשאה לפעולה זו</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{message}</p>
      <Link
        href="/"
        className="mt-5 inline-block rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-brand-600/20 transition hover:brightness-105"
      >
        חזרה ללוח הבקרה
      </Link>
    </div>
  );
}
