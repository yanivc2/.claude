"use client";

import { useEffect, useState } from "react";
import { FileText, Link2, Video, Trash2, ExternalLink, Plus } from "lucide-react";

interface Resource {
  id: string;
  title: string;
  kind: "FILE" | "LINK";
  description: string | null;
  url: string | null;
  fileName: string | null;
  mimeType: string | null;
  createdAt: string;
}

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-base sm:text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

const MAX_MB = 4;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// זיהוי קישור לסרטון (להצגת אייקון וידאו).
function isVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|vimeo\.com|\.mp4($|\?)|wistia|loom\.com/i.test(url);
}

export function ResourcesManager() {
  const [items, setItems] = useState<Resource[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [kind, setKind] = useState<"FILE" | "LINK">("FILE");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/resources");
      if (res.ok) setItems(await res.json());
    } catch {
      // מתעלמים.
    }
  }

  useEffect(() => {
    load();
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setIsOwner(!!d.isOwner))
      .catch(() => {});
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (kind === "FILE" && file && file.size > MAX_MB * 1024 * 1024) {
      setError(`הקובץ גדול מדי (עד ${MAX_MB}MB). לסרטונים כדאי להשתמש בקישור.`);
      return;
    }

    setBusy(true);
    try {
      const body: Record<string, unknown> = { title, description, kind };
      if (kind === "LINK") {
        body.url = url;
      } else {
        if (!file) throw new Error("יש לבחור קובץ");
        body.fileName = file.name;
        body.mimeType = file.type;
        body.fileData = await fileToDataUrl(file);
      }
      const res = await fetch("/api/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "שגיאה בהוספה");
      setTitle("");
      setDescription("");
      setUrl("");
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, title: string) {
    if (!window.confirm(`למחוק את "${title}"?`)) return;
    try {
      const res = await fetch(`/api/resources/${id}`, { method: "DELETE" });
      if (res.ok) await load();
    } catch {
      // מתעלמים.
    }
  }

  return (
    <div className="space-y-8">
      {/* טופס הוספה */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 className="mb-4 text-base font-bold text-slate-800">הוספת מסמך או קישור</h2>

        {/* בורר סוג */}
        <div className="mb-4 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1 text-sm font-semibold">
          <button
            type="button"
            onClick={() => setKind("FILE")}
            className={`rounded-lg px-4 py-1.5 transition ${
              kind === "FILE" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500"
            }`}
          >
            העלאת קובץ
          </button>
          <button
            type="button"
            onClick={() => setKind("LINK")}
            className={`rounded-lg px-4 py-1.5 transition ${
              kind === "LINK" ? "bg-white text-brand-700 shadow-sm" : "text-slate-500"
            }`}
          >
            קישור / סרטון
          </button>
        </div>

        <form onSubmit={add} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700">כותרת</span>
            <input
              className={inputClass}
              required
              placeholder="למשל: נוהל פתיחה וסגירה של החנות"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          {kind === "LINK" ? (
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                קישור (כולל קישור לסרטון ביוטיוב/וימאו)
              </span>
              <input
                className={inputClass}
                type="url"
                dir="ltr"
                required
                placeholder="https://youtube.com/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
          ) : (
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                קובץ (PDF, תמונה או מסמך — עד {MAX_MB}MB)
              </span>
              <input
                type="file"
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-slate-600 file:ml-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700"
              />
              {file && <p className="mt-1 text-xs text-green-700">נבחר: {file.name}</p>}
            </label>
          )}

          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700">תיאור (רשות)</span>
            <input
              className={inputClass}
              placeholder="הסבר קצר על המסמך"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand-500/25 transition hover:brightness-105 disabled:opacity-60"
            >
              <Plus size={17} />
              {busy ? "מוסיף..." : "הוספה"}
            </button>
          </div>
        </form>
        {error && <p className="mt-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      </section>

      {/* רשימת המשאבים */}
      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          עדיין לא נוספו מסמכים או קישורים.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((r) => {
            const isVideo = r.kind === "LINK" && r.url ? isVideoUrl(r.url) : false;
            const Icon = r.kind === "FILE" ? FileText : isVideo ? Video : Link2;
            const openHref = r.kind === "FILE" ? `/api/resources/${r.id}/file` : r.url ?? "#";
            return (
              <div
                key={r.id}
                className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                      isVideo ? "bg-rose-50 text-rose-600" : "bg-brand-50 text-brand-600"
                    }`}
                  >
                    <Icon size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-slate-800">{r.title}</p>
                    {r.description && (
                      <p className="mt-0.5 text-sm text-slate-500">{r.description}</p>
                    )}
                  </div>
                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => remove(r.id, r.title)}
                      aria-label="מחיקה"
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                <a
                  href={openHref}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-brand-700 transition hover:border-brand-300 hover:bg-brand-50"
                >
                  <ExternalLink size={15} />
                  {r.kind === "FILE" ? "פתיחה / הורדה" : isVideo ? "צפייה בסרטון" : "פתיחת הקישור"}
                </a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
