import type { LucideIcon } from "lucide-react";

// מצב ריק מעוצב: אייקון בעיגול רך, כותרת, תת־כותרת, ופעולה אופציונלית.
// bare=true להטמעה בתוך כרטיס קיים (בלי מסגרת/רקע משלו).
export function EmptyState({
  icon: Icon,
  title,
  subtitle,
  action,
  bare = false,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  bare?: boolean;
}) {
  const wrap = bare
    ? "px-6 py-10"
    : "rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-6 py-14";
  return (
    <div className={`flex flex-col items-center justify-center text-center ${wrap}`}>
      <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500">
        <Icon size={26} />
      </span>
      <p className="text-base font-bold text-slate-700 dark:text-slate-200">{title}</p>
      {subtitle && (
        <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
