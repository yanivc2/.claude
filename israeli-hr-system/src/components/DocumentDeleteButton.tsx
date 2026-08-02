"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { useViewer } from "./ViewerProvider";

// מחיקת מסמך עובד. מוצג לבעלים/מזכירה בלבד. כלל המזכירה: אינה יכולה למחוק
// מסמך שהבעלים העלה (uploadedByRole=OWNER) — הכפתור מוסתר, וגם השרת חוסם.
export function DocumentDeleteButton({
  docId,
  uploadedByRole,
}: {
  docId: string;
  uploadedByRole: "OWNER" | "SECRETARY" | "STORE_MANAGER" | null;
}) {
  const { role } = useViewer();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const canDelete =
    role === "OWNER" || (role === "SECRETARY" && uploadedByRole !== "OWNER");
  if (!canDelete) return null;

  async function remove() {
    if (!window.confirm("למחוק את המסמך? פעולה זו בלתי הפיכה.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${docId}`, { method: "DELETE" });
      if (res.ok) router.refresh();
      else {
        const b = await res.json().catch(() => ({}));
        if (b.error) alert(b.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={remove}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1 text-xs text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-slate-700 dark:text-red-400 dark:hover:bg-red-500/15"
    >
      <Trash2 size={13} />
      מחיקה
    </button>
  );
}
