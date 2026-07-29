import { Video, PlayCircle } from "lucide-react";
import { currentEmployee } from "@/lib/session";
import { employeeResources, isVideoUrl, youtubeId } from "@/lib/employee-resources";

export const metadata = { title: "סרטוני הדרכה" };

// סרטוני הדרכה לעובד — קישורי וידאו (יוטיוב מוטמע / קישור חיצוני).
export default async function MyVideosPage() {
  const me = await currentEmployee();
  if (!me) return null;

  const all = await employeeResources(me.companyId);
  const videos = all.filter((r) => r.kind === "LINK" && isVideoUrl(r.url));

  return (
    <div className="space-y-5 py-2">
      <div className="flex items-center gap-2.5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500/15 to-accent-500/15 text-brand-600 dark:text-accent-300">
          <Video size={20} />
        </span>
        <h1 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">סרטוני הדרכה</h1>
      </div>

      {videos.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-400 dark:border-slate-700">
          אין סרטונים להצגה כרגע
        </p>
      ) : (
        <div className="space-y-4 animate-stagger">
          {videos.map((r, i) => {
            const yt = r.url ? youtubeId(r.url) : null;
            return (
              <div
                key={r.id}
                style={{ "--i": i } as React.CSSProperties}
                className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white/70 shadow-card backdrop-blur dark:border-slate-800 dark:bg-slate-900/60"
              >
                {yt ? (
                  <div className="relative aspect-video w-full bg-black">
                    <iframe
                      className="absolute inset-0 h-full w-full"
                      src={`https://www.youtube.com/embed/${yt}`}
                      title={r.title}
                      loading="lazy"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                ) : (
                  <a
                    href={r.url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex aspect-video w-full items-center justify-center bg-gradient-to-br from-brand-600 to-accent-600 text-white"
                  >
                    <PlayCircle size={54} />
                  </a>
                )}
                <div className="p-4">
                  <p className="font-bold text-slate-800 dark:text-slate-100">{r.title}</p>
                  {r.description && (
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{r.description}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
