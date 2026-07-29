"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Loader2, Bell } from "lucide-react";

interface Task {
  id: string;
  title: string;
  status: "SENT" | "DONE";
  assigneeScope: "ALL" | "TEAM" | "EMPLOYEE";
  createdAt: string;
}

function scopeLabel(s: Task["assigneeScope"]): string {
  if (s === "EMPLOYEE") return "אישית";
  if (s === "TEAM") return "צוות המשמרת";
  return "כל העובדים";
}

// המרת מפתח VAPID (base64url) ל-ArrayBuffer עבור הרשמת פוש
// (מגובה ב-ArrayBuffer מפורש כדי לספק את הטיפוס BufferSource).
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

// רשימת המשימות של העובד — סימון "בוצע" + הפעלת התראות פוש.
export function MyTasks() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pushState, setPushState] = useState<"unknown" | "on" | "off">("unknown");

  async function load() {
    const res = await fetch("/api/my-tasks");
    if (res.ok) setTasks(await res.json());
    else setTasks([]);
  }

  useEffect(() => {
    load();
    if (typeof Notification !== "undefined") {
      setPushState(Notification.permission === "granted" ? "on" : "off");
    }
  }, []);

  async function toggle(t: Task) {
    setBusyId(t.id);
    const next = t.status === "DONE" ? "SENT" : "DONE";
    const res = await fetch(`/api/my-tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) {
      setTasks((prev) => prev?.map((x) => (x.id === t.id ? { ...x, status: next } : x)) ?? null);
    }
    setBusyId(null);
  }

  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.register("/sw.js");
      const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!key) {
        setPushState("on");
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(key),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });
      setPushState("on");
    } catch {
      /* משתמש ביטל / לא נתמך — לא חוסם */
    }
  }

  if (tasks === null) {
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const open = tasks.filter((t) => t.status !== "DONE");
  const done = tasks.filter((t) => t.status === "DONE");

  return (
    <div className="space-y-5 py-2">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">המשימות שלי</h1>
        {pushState === "off" && (
          <button
            type="button"
            onClick={enablePush}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-bold text-brand-700 transition hover:bg-brand-100 dark:bg-brand-500/15 dark:text-brand-300"
          >
            <Bell size={14} />
            הפעלת התראות
          </button>
        )}
      </div>

      {tasks.length === 0 && (
        <p className="rounded-2xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-400 dark:border-slate-700">
          אין משימות כרגע 🎉
        </p>
      )}

      {open.length > 0 && (
        <ul className="space-y-2.5 animate-stagger">
          {open.map((t, i) => (
            <li
              key={t.id}
              style={{ "--i": i } as React.CSSProperties}
              className="flex items-start gap-3 rounded-2xl border border-slate-200/80 bg-white/80 p-4 shadow-card backdrop-blur dark:border-slate-800 dark:bg-slate-900/60"
            >
              <button
                type="button"
                onClick={() => toggle(t)}
                disabled={busyId === t.id}
                aria-label="סימון כבוצע"
                className="mt-0.5 shrink-0 text-slate-300 transition hover:text-brand-600 disabled:opacity-50 dark:text-slate-600"
              >
                {busyId === t.id ? <Loader2 size={24} className="animate-spin" /> : <Circle size={24} />}
              </button>
              <div className="min-w-0 flex-1">
                <p className="font-semibold leading-snug text-slate-800 dark:text-slate-100">{t.title}</p>
                <span className="mt-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {scopeLabel(t.assigneeScope)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <div className="space-y-2.5">
          <h2 className="pt-2 text-xs font-bold uppercase tracking-wide text-slate-400">בוצעו</h2>
          <ul className="space-y-2.5">
            {done.map((t) => (
              <li
                key={t.id}
                className="flex items-start gap-3 rounded-2xl border border-slate-200/60 bg-slate-50/60 p-4 dark:border-slate-800/60 dark:bg-slate-900/30"
              >
                <button
                  type="button"
                  onClick={() => toggle(t)}
                  disabled={busyId === t.id}
                  aria-label="ביטול סימון"
                  className="mt-0.5 shrink-0 text-emerald-500 transition hover:text-emerald-600 disabled:opacity-50"
                >
                  {busyId === t.id ? <Loader2 size={24} className="animate-spin" /> : <CheckCircle2 size={24} />}
                </button>
                <p className="min-w-0 flex-1 font-medium leading-snug text-slate-400 line-through dark:text-slate-500">
                  {t.title}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
