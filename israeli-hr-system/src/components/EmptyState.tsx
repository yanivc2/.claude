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
    : "rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-white/70 dark:bg-slate-900/60 px-6 py-14 backdrop-blur-sm";
  return (
    <div className={`flex flex-col items-center justify-center text-center ${wrap}`}>
      <span className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand-500/12 to-accent-500/12 text-brand-500 ring-1 ring-inset ring-brand-500/15 dark:text-brand-300">
        <Icon size={28} />
      </span>
      <p className="text-base font-bold text-slate-700 dark:text-slate-200">{title}</p>
      {subtitle && (
        <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
