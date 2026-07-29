"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, Printer, Mail, Trash2, FileText } from "lucide-react";
import { useViewer } from "./ViewerProvider";

interface Doc {
  id: string;
  fileName: string;
  mimeType: string | null;
  fileUrl: string; // data URL
  uploadedByRole: "OWNER" | "SECRETARY" | "STORE_MANAGER" | null;
}
interface Contact {
  id: string;
  type: "GENERAL" | "PENSION_AGENT";
  name: string;
  email: string | null;
  phone: string | null;
}

// ממיר data URL ל-File לצורך שיתוף/הדפסה.
function dataUrlToFile(dataUrl: string, fileName: string): File {
  const [meta, b64] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(meta)?.[1] || "application/octet-stream";
  const bin = atob(b64 || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], fileName, { type: mime });
}

function openInTab(doc: Doc) {
  const url = URL.createObjectURL(dataUrlToFile(doc.fileUrl, doc.fileName));
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

const btn =
  "inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/60";

export function PensionDocuments({
  employeeId,
  employeeName,
  initialDocs,
}: {
  employeeId: string;
  employeeName: string;
  initialDocs: Doc[];
}) {
  const { role } = useViewer();
  const canWrite = role === "OWNER" || role === "SECRETARY";
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mailFor, setMailFor] = useState<string | null>(null); // docId שנפתח לו בורר נמען

  useEffect(() => {
    fetch("/api/contacts")
      .then((r) => (r.ok ? r.json() : []))
      .then((c: Contact[]) =>
        setContacts(c.sort((a, b) => (a.type === "PENSION_AGENT" ? -1 : 1))),
      )
      .catch(() => {});
  }, []);

  async function upload(file: File) {
    setError("");
    if (file.size > 4 * 1024 * 1024) {
      setError("הקובץ גדול מדי (עד 4MB).");
      return;
    }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(rd.result as string);
        rd.onerror = reject;
        rd.readAsDataURL(file);
      });
      const res = await fetch(`/api/employees/${employeeId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "PENSION_TRANSFER", fileName: file.name, mimeType: file.type, data }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "שגיאה בהעלאה");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  async function remove(doc: Doc) {
    if (!window.confirm("למחוק את המסמך?")) return;
    const res = await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
    else {
      const b = await res.json().catch(() => ({}));
      if (b.error) alert(b.error);
    }
  }

  async function sendEmail(doc: Doc, contactId: string) {
    setMailFor(null);
    const res = await fetch(`/api/documents/${doc.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId }),
    });
    const b = await res.json().catch(() => ({}));
    alert(res.ok ? "המסמך נשלח במייל ✓" : b.error ?? "שליחת המייל נכשלה");
  }

  async function whatsapp(doc: Doc, phone?: string | null) {
    const file = dataUrlToFile(doc.fileUrl, doc.fileName);
    const text = `מסמך פנסיה — ${employeeName} (${doc.fileName})`;
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: doc.fileName, text });
        return;
      } catch {
        // בוטל/נכשל — נופלים לקישור.
      }
    }
    openInTab(doc); // מאפשר למשתמש לצרף ידנית
    const digits = (phone || "").replace(/\D/g, "");
    window.open(
      digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  const agents = contacts.filter((c) => c.email);

  return (
    <div className="space-y-3">
      {initialDocs.length === 0 ? (
        <p className="text-sm text-slate-400">לא נשמרו מסמכי העברות פנסיה.</p>
      ) : (
        <ul className="space-y-2">
          {initialDocs.map((doc) => (
            <li key={doc.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <FileText size={15} className="text-brand-600 dark:text-brand-300" />
                  {doc.fileName}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => openInTab(doc)} className={btn}>
                    <Printer size={13} /> הדפסה
                  </button>
                  <button type="button" onClick={() => whatsapp(doc)} className={btn}>
                    וואטסאפ
                  </button>
                  <button
                    type="button"
                    onClick={() => setMailFor(mailFor === doc.id ? null : doc.id)}
                    className={btn}
                  >
                    <Mail size={13} /> מייל
                  </button>
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => remove(doc)}
                      className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15"
                      aria-label="מחיקה"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>
              {mailFor === doc.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/50">
                  {agents.length === 0 ? (
                    <span className="text-xs text-slate-500">
                      אין אנשי קשר עם דוא״ל. הוסף/י ב&ldquo;אנשי קשר&rdquo;.
                    </span>
                  ) : (
                    <>
                      <span className="text-xs text-slate-500">שליחה אל:</span>
                      <select
                        defaultValue=""
                        onChange={(e) => e.target.value && sendEmail(doc, e.target.value)}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
                      >
                        <option value="" disabled>
                          בחר/י איש קשר…
                        </option>
                        {agents.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.type === "PENSION_AGENT" ? " (פנסיה)" : ""}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl border border-dashed border-brand-300 px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-60 dark:border-brand-500/40 dark:text-brand-300 dark:hover:bg-brand-500/10"
          >
            <Upload size={15} />
            {busy ? "מעלה…" : "העלאת מסמך העברת פנסיה"}
          </button>
          {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
