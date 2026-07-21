"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// כפתורי פעולה לעובד ברשימה: העברה ל"לא פעיל" / החזרה לפעיל, ומחיקה.
export function EmployeeRowActions({
  id,
  name,
  isInactive,
}: {
  id: string;
  name: string;
  isInactive: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function setStatus(status: "ACTIVE" | "INACTIVE") {
    setBusy(true);
    try {
      const res = await fetch(`/api/employees/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`למחוק לצמיתות את ${name}? כל המסמכים והחתימות יימחקו. פעולה זו בלתי הפיכה.`))
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/employees/${id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {isInactive ? (
        <button
          type="button"
          onClick={() => setStatus("ACTIVE")}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-green-700 transition hover:bg-green-50 disabled:opacity-50"
        >
          ↩︎ החזרה לפעיל
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setStatus("INACTIVE")}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
        >
          העברה ללא פעיל
        </button>
      )}
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
      >
        🗑️ מחיקה
      </button>
    </div>
  );
}
