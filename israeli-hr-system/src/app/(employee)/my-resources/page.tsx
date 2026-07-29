import { FolderOpen, FileText, ExternalLink, Download } from "lucide-react";
import { currentEmployee } from "@/lib/session";
import { employeeResources, isVideoUrl } from "@/lib/employee-resources";

export const metadata = { title: "נהלים ומסמכים" };

// נהלים ומסמכים לעובד — קבצים וקישורים שאינם סרטונים.
export default async function MyResourcesPage() {
  const me = await currentEmployee();
  if (!me) return null;

  const all = await employeeResources(me.companyId);
  const items = all.filter((r) => !(r.kind === "LINK" && isVideoUrl(r.url)));

  return (
    <div className="space-y-5 py-2">
      <div className="flex items-center gap-2.5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500/15 to-accent-500/15 text-brand-600 dark:text-accent-300">
          <FolderOpen size={20} />
        </span>
        <h1 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">נהלים ומסמכים</h1>
      </div>

      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-400 dark:border-slate-700">
          אין חומרים להצגה כרגע
        </p>
      ) : (
        <ul className="space-y-2.5 animate-stagger">
          {items.map((r, i) => {
            const isFile = r.kind === "FILE";
            const href = isFile ? `/api/resources/${r.id}/file` : r.url ?? "#";
            return (
              <li key={r.id} style={{ "--i": i } as React.CSSProperties}>
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover-lift flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white/70 p-4 shadow-card backdrop-blur dark:border-slate-800 dark:bg-slate-900/60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {isFile ? <FileText size={19} /> : <ExternalLink size={19} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-slate-800 dark:text-slate-100">{r.title}</span>
                    {r.description && (
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        {r.description}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-slate-400">
                    {isFile ? <Download size={18} /> : <ExternalLink size={18} />}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
