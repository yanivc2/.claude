"use client";

import { useEffect, useState } from "react";
import {
  FileText,
  Link2,
  Video,
  Trash2,
  ExternalLink,
  Plus,
  Folder,
  FolderPlus,
  FolderOpen,
  X,
  Download,
  ChevronDown,
} from "lucide-react";
import { shareWhatsApp, mailtoHref } from "@/lib/share";
import { EmptyState } from "./EmptyState";

interface Resource {
  id: string;
  title: string;
  kind: "FILE" | "LINK";
  description: string | null;
  url: string | null;
  fileName: string | null;
  mimeType: string | null;
  folderId: string | null;
  createdAt: string;
}
interface FolderT {
  id: string;
  name: string;
  count: number;
}

const inputClass =
  "w-full rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-base sm:text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";
const MAX_MB = 4;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function isVideoUrl(url: string): boolean {
  return /youtube\.com|youtu\.be|vimeo\.com|\.mp4($|\?)|wistia|loom\.com/i.test(url);
}
function fileHref(r: Resource): string {
  return `/api/resources/${r.id}/file`;
}
// טקסט שיתוף: כותרת + קישור מלא (קובץ = נקודת הקצה; קישור = ה-URL).
function shareText(r: Resource): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = r.kind === "FILE" ? `${origin}${fileHref(r)}` : r.url ?? "";
  return `${r.title}\n${link}`;
}

// הורדה אמיתית: מושכים את הקובץ כ-blob ומורידים — בלי לנווט/לפתוח את המסמך מחדש.
async function downloadFile(r: Resource) {
  try {
    const res = await fetch(`${fileHref(r)}?download=1`);
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = r.fileName || r.title || "file";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 2000);
  } catch {
    // גיבוי: פתיחה בכרטיסייה עם דרישת הורדה.
    window.open(`${fileHref(r)}?download=1`, "_blank", "noopener,noreferrer");
  }
}

export function ResourcesManager() {
  const [items, setItems] = useState<Resource[]>([]);
  const [folders, setFolders] = useState<FolderT[]>([]);
  const [isOwner, setIsOwner] = useState(false);

  // טופס הוספה
  const [kind, setKind] = useState<"FILE" | "LINK">("FILE");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // תיקייה חדשה
  const [newFolder, setNewFolder] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  // תצוגה
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [viewing, setViewing] = useState<Resource | null>(null);

  async function load() {
    try {
      const [r1, r2] = await Promise.all([fetch("/api/resources"), fetch("/api/resources/folders")]);
      if (r1.ok) setItems(await r1.json());
      if (r2.ok) setFolders(await r2.json());
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

  // סגירת המציג במקש Escape.
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setViewing(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  async function createFolder() {
    const name = newFolder.trim();
    if (!name) return;
    setError("");
    try {
      const res = await fetch("/api/resources/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "שגיאה ביצירת תיקייה");
      setNewFolder("");
      setCreatingFolder(false);
      if (data.id) setFolderId(data.id); // המשך העלאה לתיקייה החדשה
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה לא צפויה");
    }
  }

  async function deleteFolder(id: string, name: string) {
    if (!window.confirm(`למחוק את התיקייה "${name}"? המסמכים שבתוכה יעברו לרמה העליונה.`)) return;
    try {
      const res = await fetch(`/api/resources/folders/${id}`, { method: "DELETE" });
      if (res.ok) await load();
    } catch {
      // מתעלמים.
    }
  }

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
      if (folderId) body.folderId = folderId;
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

  // העברת משאב לתיקייה (או הוצאה ממנה — folderId ריק = null).
  async function move(id: string, targetFolderId: string) {
    try {
      const res = await fetch(`/api/resources/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: targetFolderId || null }),
      });
      if (res.ok) await load();
    } catch {
      // מתעלמים.
    }
  }

  const loose = items.filter((r) => !r.folderId);

  return (
    <div className="space-y-8">
      {/* טופס הוספה */}
      <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm sm:p-6">
        <h2 className="mb-4 text-base font-bold text-slate-800 dark:text-slate-100">הוספת מסמך או קישור</h2>

        <div className="mb-4 inline-flex rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-1 text-sm font-semibold">
          {(["FILE", "LINK"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-lg px-4 py-1.5 transition ${
                kind === k
                  ? "bg-white dark:bg-slate-900 text-brand-700 dark:text-brand-300 shadow-sm"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {k === "FILE" ? "העלאת קובץ" : "קישור / סרטון"}
            </button>
          ))}
        </div>

        <form onSubmit={add} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">כותרת</span>
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
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
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
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
                קובץ (PDF, תמונה או מסמך — עד {MAX_MB}MB)
              </span>
              <input
                type="file"
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-slate-600 dark:text-slate-300 file:ml-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-medium file:text-brand-700"
              />
              {file && <p className="mt-1 text-xs text-green-700 dark:text-green-400">נבחר: {file.name}</p>}
            </label>
          )}

          {/* בחירת תיקייה */}
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">תיקייה</span>
            <select className={inputClass} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">ללא תיקייה (רמה עליונה)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">תיאור (רשות)</span>
            <input
              className={inputClass}
              placeholder="הסבר קצר על המסמך"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-brand-500/25 transition hover:brightness-105 disabled:opacity-60"
            >
              <Plus size={17} />
              {busy ? "מוסיף..." : "הוספה"}
            </button>

            {/* יצירת תיקייה חדשה */}
            {creatingFolder ? (
              <div className="flex items-center gap-2">
                <input
                  className={inputClass + " !w-44"}
                  autoFocus
                  placeholder="שם התיקייה"
                  value={newFolder}
                  onChange={(e) => setNewFolder(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), createFolder())}
                />
                <button
                  type="button"
                  onClick={createFolder}
                  className="rounded-lg bg-slate-800 dark:bg-slate-700 px-3 py-2 text-sm font-semibold text-white"
                >
                  יצירה
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreatingFolder(false);
                    setNewFolder("");
                  }}
                  className="text-sm text-slate-500 dark:text-slate-400"
                >
                  ביטול
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreatingFolder(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200 transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <FolderPlus size={17} />
                תיקייה חדשה
              </button>
            )}
          </div>
        </form>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 dark:bg-red-500/15 px-4 py-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </section>

      {/* תיקיות */}
      {folders.map((f) => {
        const inFolder = items.filter((r) => r.folderId === f.id);
        const open = openFolders[f.id] ?? true;
        return (
          <section
            key={f.id}
            className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm"
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => setOpenFolders((s) => ({ ...s, [f.id]: !open }))}
                className="flex flex-1 items-center gap-3 text-start"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300">
                  <Folder size={18} />
                </span>
                <span className="font-bold text-slate-800 dark:text-slate-100">{f.name}</span>
                <span className="text-xs text-slate-400 dark:text-slate-400">
                  {inFolder.length} פריטים
                </span>
                <ChevronDown
                  size={18}
                  className={`text-slate-400 transition ${open ? "rotate-180" : ""}`}
                />
              </button>
              {isOwner && (
                <button
                  type="button"
                  onClick={() => deleteFolder(f.id, f.name)}
                  aria-label="מחיקת תיקייה"
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            {open && (
              <div className="border-t border-slate-100 dark:border-slate-800 p-4">
                {inFolder.length === 0 ? (
                  <p className="py-4 text-center text-sm text-slate-400 dark:text-slate-400">
                    התיקייה ריקה. בחר/י אותה בטופס למעלה כדי להעלות אליה.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {inFolder.map((r) => (
                      <Card key={r.id} r={r} folders={folders} isOwner={isOwner} onView={setViewing} onRemove={remove} onMove={move} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      {/* משאבים ללא תיקייה */}
      {(loose.length > 0 || folders.length === 0) && (
        <section>
          {folders.length > 0 && (
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-400 dark:text-slate-400">
              ללא תיקייה
            </h2>
          )}
          {loose.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="עדיין לא נוספו מסמכים"
              subtitle="הוסף/י מסמך או קישור בטופס למעלה, או צור/י תיקייה לארגון."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {loose.map((r) => (
                <Card key={r.id} r={r} folders={folders} isOwner={isOwner} onView={setViewing} onRemove={remove} onMove={move} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* מציג מסמך עם כפתור סגירה */}
      {viewing && <Viewer r={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

// ─── כרטיס משאב ───
function Card({
  r,
  folders,
  isOwner,
  onView,
  onRemove,
  onMove,
}: {
  r: Resource;
  folders: FolderT[];
  isOwner: boolean;
  onView: (r: Resource) => void;
  onRemove: (id: string, title: string) => void;
  onMove: (id: string, folderId: string) => void;
}) {
  const isVideo = r.kind === "LINK" && r.url ? isVideoUrl(r.url) : false;
  const Icon = r.kind === "FILE" ? FileText : isVideo ? Video : Link2;

  return (
    <div className="flex flex-col rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm transition hover:shadow-md">
      <div className="flex items-start gap-3">
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
            isVideo
              ? "bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-300"
              : "bg-brand-50 dark:bg-brand-500/15 text-brand-600 dark:text-brand-300"
          }`}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800 dark:text-slate-100">{r.title}</p>
          {r.description && (
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{r.description}</p>
          )}
        </div>
        {isOwner && (
          <button
            type="button"
            onClick={() => onRemove(r.id, r.title)}
            aria-label="מחיקה"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-red-50 dark:hover:bg-red-500/15 hover:text-red-600 dark:hover:text-red-400"
          >
            <Trash2 size={18} />
          </button>
        )}
      </div>

      {/* פעולה ראשית + שיתוף */}
      <div className="mt-4 flex items-center gap-2">
        {r.kind === "FILE" ? (
          <button
            type="button"
            onClick={() => onView(r)}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 px-3 text-sm font-bold text-brand-700 dark:text-brand-300 transition hover:border-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10"
          >
            <ExternalLink size={17} />
            פתיחה
          </button>
        ) : (
          <a
            href={r.url ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 px-3 text-sm font-bold text-brand-700 dark:text-brand-300 transition hover:border-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10"
          >
            <ExternalLink size={17} />
            {isVideo ? "צפייה בסרטון" : "פתיחת הקישור"}
          </a>
        )}
        <ShareButtons r={r} />
      </div>

      {/* העברה לתיקייה */}
      <label className="mt-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <Folder size={14} className="shrink-0" />
        <select
          value={r.folderId ?? ""}
          onChange={(e) => onMove(r.id, e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-transparent px-2 py-1.5 text-xs outline-none focus:border-brand-500"
        >
          <option value="">ללא תיקייה</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ─── כפתורי שיתוף (וואטסאפ / מייל) — יעד לחיצה נוח (44px) ───
function ShareButtons({ r }: { r: Resource }) {
  return (
    <>
      <button
        type="button"
        title="שליחה בוואטסאפ"
        aria-label="שליחה בוואטסאפ"
        onClick={() => shareWhatsApp(shareText(r))}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-green-300 dark:border-green-500/40 text-lg transition hover:bg-green-50 dark:hover:bg-green-500/15"
      >
        📱
      </button>
      <a
        title="שליחה במייל"
        aria-label="שליחה במייל"
        href={mailtoHref(r.title, shareText(r))}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-slate-300 dark:border-slate-700 text-lg transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
      >
        ✉️
      </a>
    </>
  );
}

// ─── מציג מסמך עם כפתור סגירה ───
function Viewer({ r, onClose }: { r: Resource; onClose: () => void }) {
  const isPdf = (r.mimeType ?? "").includes("pdf") || (r.fileName ?? "").toLowerCase().endsWith(".pdf");
  const isImage = (r.mimeType ?? "").startsWith("image/");
  const href = fileHref(r);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white dark:bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 px-3 py-2.5">
          <p className="min-w-0 flex-1 truncate font-bold text-slate-800 dark:text-slate-100">{r.title}</p>
          <ShareButtons r={r} />
          <button
            type="button"
            onClick={() => downloadFile(r)}
            title="הורדה"
            aria-label="הורדה"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            <Download size={18} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגירה"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-800 dark:bg-slate-700 text-white transition hover:bg-slate-900 dark:hover:bg-slate-600"
          >
            <X size={20} />
          </button>
        </header>
        <div className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-950">
          {isPdf ? (
            <iframe src={href} title={r.title} className="h-[78vh] w-full" />
          ) : isImage ? (
            <div className="flex justify-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={href} alt={r.title} className="max-h-[78vh] max-w-full object-contain" />
            </div>
          ) : (
            <div className="p-8 text-center">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                לא ניתן להציג תצוגה מקדימה לקובץ מסוג זה.
              </p>
              <button
                type="button"
                onClick={() => downloadFile(r)}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700"
              >
                <Download size={16} />
                הורדת הקובץ
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
