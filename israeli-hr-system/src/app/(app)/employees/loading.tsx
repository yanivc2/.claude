// שלד טעינה למסך העובדים — מוצג אוטומטית בזמן שאילתת ה-DB (Suspense של App Router).
export default function EmployeesLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="skeleton h-7 w-40 rounded-lg" />
          <div className="skeleton h-4 w-28 rounded" />
        </div>
        <div className="skeleton h-11 w-40 rounded-xl" />
      </div>

      {/* סרגל חיפוש + תגי סינון */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="skeleton h-11 w-full rounded-xl lg:max-w-xs" />
        <div className="flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-8 w-20 rounded-full" />
          ))}
        </div>
      </div>

      {/* שורות טבלה */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-slate-100 dark:border-slate-800 px-5 py-4 last:border-b-0"
          >
            <div className="skeleton h-9 w-9 shrink-0 rounded-full" />
            <div className="skeleton h-4 w-40 rounded" />
            <div className="skeleton ms-auto h-4 w-24 rounded" />
            <div className="skeleton h-6 w-16 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
