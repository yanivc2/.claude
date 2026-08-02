import { Scale, ArrowLeft } from "lucide-react";
import { prisma } from "@/lib/prisma";
import type { LegalCategory } from "@prisma/client";
import { EmptyState } from "@/components/EmptyState";

const CATEGORY_LABELS: Record<LegalCategory, string> = {
  LEGISLATION: "חקיקה",
  RULING: "פסיקה",
  REGULATION: "תקנות",
  GENERAL: "כללי",
};

const CATEGORY_STYLES: Record<LegalCategory, string> = {
  LEGISLATION: "bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300",
  RULING: "bg-purple-50 dark:bg-purple-500/15 text-purple-700 dark:text-purple-300",
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
      <EmptyState
        icon={Scale}
        title="אין עדכוני חקיקה עדיין"
        subtitle="המערכת מושכת עדכונים אוטומטית אחת לשבוע ממקורות ציבוריים."
      />
    );
  }

  return (
    <div className="space-y-4">
      {updates.map((u) => (
        <article
          key={u.id}
          className="group rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm transition hover:border-brand-200 hover:shadow-md"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${CATEGORY_STYLES[u.category]}`}
            >
              {CATEGORY_LABELS[u.category]}
            </span>
            <time className="text-xs text-slate-400 dark:text-slate-400">{dateFmt.format(u.publishedAt)}</time>
          </div>
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">{u.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{u.summary}</p>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-400">
            <span>מקור: {u.source}</span>
            {u.sourceUrl && (
              <a
                href={u.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-brand-600 dark:text-brand-300 hover:underline"
              >
                קריאה במקור
                <ArrowLeft size={13} />
              </a>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
