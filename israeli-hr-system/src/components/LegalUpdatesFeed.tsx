import { prisma } from "@/lib/prisma";
import type { LegalCategory } from "@prisma/client";

const CATEGORY_LABELS: Record<LegalCategory, string> = {
  LEGISLATION: "חקיקה",
  RULING: "פסיקה",
  REGULATION: "תקנות",
  GENERAL: "כללי",
};

const CATEGORY_STYLES: Record<LegalCategory, string> = {
  LEGISLATION: "bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300",
  RULING: "bg-purple-50 text-purple-700",
  REGULATION: "bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
  GENERAL: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
};

const dateFmt = new Intl.DateTimeFormat("he-IL", {
  day: "2-digit",
  month: "long",
  year: "numeric",
});

// רכיב שרת: מציג את עדכוני החקיקה כרונולוגית (החדשים ראשונים).
export async function LegalUpdatesFeed() {
  const updates = await prisma.legalUpdate.findMany({
    orderBy: { publishedAt: "desc" },
    take: 30,
  });

  if (updates.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center text-sm text-slate-500 dark:text-slate-400">
        אין עדכוני חקיקה עדיין. המערכת מושכת עדכונים אוטומטית אחת לשבוע.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {updates.map((u) => (
        <article key={u.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CATEGORY_STYLES[u.category]}`}
            >
              {CATEGORY_LABELS[u.category]}
            </span>
            <time className="text-xs text-slate-400 dark:text-slate-500">{dateFmt.format(u.publishedAt)}</time>
          </div>
          <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">{u.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{u.summary}</p>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
            <span>מקור: {u.source}</span>
            {u.sourceUrl && (
              <a
                href={u.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 dark:text-brand-300 hover:underline"
              >
                קריאה במקור ←
              </a>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
