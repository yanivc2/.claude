"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, BellRing, Check, X } from "lucide-react";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  actorName: string | null;
  read: boolean;
  createdAt: string;
}

// ממיר מפתח VAPID (base64url) ל-ArrayBuffer הנדרש ל-pushManager.subscribe.
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

const relTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "עכשיו";
  if (m < 60) return `לפני ${m} דק׳`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} ש׳`;
  const d = Math.floor(h / 24);
  return `לפני ${d} ימים`;
};

// פעמון התראות לבעלים: מרכז התראות בתוך האפליקציה + הפעלת פוש לטלפון.
// openUp — פתיחת החלון כלפי מעלה (כשהפעמון בתחתית, למשל בכרטיס המשתמש בסרגל).
export function NotificationBell({ openUp = false }: { openUp?: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [pushState, setPushState] = useState<"unknown" | "unsupported" | "off" | "on">("unknown");
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      // מתעלמים.
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  // בדיקת מצב מנוי הפוש הנוכחי.
  useEffect(() => {
    (async () => {
      if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushState("unsupported");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        setPushState(sub ? "on" : "off");
      } catch {
        setPushState("off");
      }
    })();
  }, []);

  // סגירה בלחיצה מחוץ לתפריט.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function markAll() {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
    setUnread(0);
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  async function enablePush() {
    setBusy(true);
    try {
      const cfg = await fetch("/api/push/subscribe").then((r) => (r.ok ? r.json() : null));
      if (!cfg?.enabled || !cfg?.publicKey) {
        alert("התראות פוש אינן מוגדרות עדיין בשרת. יש להוסיף מפתחות VAPID.");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        alert("כדי לקבל התראות יש לאשר התראות בדפדפן.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBuffer(cfg.publicKey),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (res.ok) setPushState("on");
    } catch {
      alert("לא ניתן היה להפעיל התראות במכשיר זה.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-label="התראות"
        onClick={() => {
          setOpen((o) => !o);
          if (!open && unread > 0) markAll();
        }}
        className="relative grid h-9 w-9 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {unread > 0 ? <BellRing size={19} /> : <Bell size={19} />}
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`z-50 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900 fixed inset-x-3 top-16 max-h-[75vh] sm:absolute sm:inset-x-auto sm:top-auto sm:bottom-auto sm:right-0 sm:w-80 sm:max-w-[calc(100vw-1.5rem)] sm:max-h-[70vh] ${
            openUp ? "sm:bottom-full sm:mb-2" : "sm:top-full sm:mt-2"
          }`}
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <span className="text-sm font-bold text-slate-800 dark:text-slate-100">התראות</span>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
              <X size={16} />
            </button>
          </div>

          {pushState === "off" && (
            <button
              type="button"
              onClick={enablePush}
              disabled={busy}
              className="flex w-full items-center gap-2 border-b border-slate-100 bg-brand-50 px-4 py-2.5 text-right text-xs font-semibold text-brand-700 transition hover:bg-brand-100 disabled:opacity-60 dark:border-slate-800 dark:bg-brand-500/10 dark:text-brand-300"
            >
              <BellRing size={15} />
              {busy ? "מפעיל…" : "הפעלת התראות לטלפון (פוש)"}
            </button>
          )}
          {pushState === "on" && (
            <p className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-2 text-[11px] text-green-600 dark:border-slate-800 dark:text-green-400">
              <Check size={13} /> התראות לטלפון פעילות במכשיר זה
            </p>
          )}

          <div className="max-h-[52vh] overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">אין התראות</p>
            ) : (
              items.map((n) => {
                const inner = (
                  <>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{n.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{n.body}</p>
                    <p className="mt-1 text-[10px] text-slate-400">
                      {n.actorName ? `${n.actorName} · ` : ""}
                      {relTime(n.createdAt)}
                    </p>
                  </>
                );
                const cls = `block border-b border-slate-50 px-4 py-3 transition hover:bg-slate-50 dark:border-slate-800/60 dark:hover:bg-slate-800/40 ${
                  n.read ? "" : "bg-brand-50/40 dark:bg-brand-500/5"
                }`;
                return n.link ? (
                  <Link key={n.id} href={n.link} className={cls} onClick={() => setOpen(false)}>
                    {inner}
                  </Link>
                ) : (
                  <div key={n.id} className={cls}>
                    {inner}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
