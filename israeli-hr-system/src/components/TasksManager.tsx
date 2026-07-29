"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Check, Clock, Send, Bookmark, ClipboardList, ListChecks } from "lucide-react";

interface Employee {
  id: string;
  name: string;
}
interface Task {
  id: string;
  title: string;
  assigneeScope: "ALL" | "TEAM" | "EMPLOYEE";
  employeeName: string | null;
  status: "SENT" | "DONE";
  createdAt: string;
}
interface Preset {
  id: string;
  title: string;
}
interface Procedure {
  id: string;
  type: "OPEN" | "CLOSE";
  assigneeScope: "ALL" | "TEAM" | "EMPLOYEE";
  items: string[];
  createdAt: string;
}

const inputClass =
  "w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-base sm:text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

const SCOPE_LABEL = { ALL: "כל העובדים", TEAM: "צוות המשמרת", EMPLOYEE: "עובד ספציפי" } as const;

export function TasksManager({ employees }: { employees: Employee[] }) {
  const [tab, setTab] = useState<"tasks" | "procedures">("tasks");

  return (
    <div className="space-y-5">
      {/* Segmented control */}
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-800 dark:bg-slate-800/50">
        {(["tasks", "procedures"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-lg py-2 text-sm font-bold transition ${
              tab === t
                ? "bg-gradient-to-l from-brand-500 to-accent-600 text-white shadow"
                : "text-slate-500 dark:text-slate-400"
            }`}
          >
            {t === "tasks" ? "משימות" : "נהלי משמרת"}
          </button>
        ))}
      </div>

      {tab === "tasks" ? <TasksTab employees={employees} /> : <ProceduresTab employees={employees} />}
    </div>
  );
}

// ─────────────────────── טאב משימות ───────────────────────
function TasksTab({ employees }: { employees: Employee[] }) {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"ALL" | "TEAM" | "EMPLOYEE">("ALL");
  const [employeeId, setEmployeeId] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [p, t] = await Promise.all([
      fetch("/api/task-presets").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/tasks").then((r) => (r.ok ? r.json() : [])),
    ]);
    setPresets(p);
    setTasks(t);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function send() {
    setError("");
    if (!title.trim()) return setError("יש להזין תיאור משימה");
    if (scope === "EMPLOYEE" && !employeeId) return setError("יש לבחור עובד");
    setBusy(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, assigneeScope: scope, employeeId: scope === "EMPLOYEE" ? employeeId : null }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error ?? "שגיאה");
      setTitle("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  async function savePreset() {
    if (!title.trim()) return;
    await fetch("/api/task-presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    }).catch(() => {});
    await load();
  }

  async function markDone(t: Task) {
    await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: t.status === "DONE" ? "SENT" : "DONE" }),
    }).catch(() => {});
    await load();
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 shadow-card backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/70 sm:p-5">
        <h2 className="mb-3 text-base font-bold text-slate-800 dark:text-slate-100">משימה חדשה</h2>
        <label className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">תיאור המשימה</label>
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="לדוגמה: פרונטים במעברים 3–5" />

        {presets.length > 0 && (
          <>
            <p className="mb-1 mt-3 text-sm font-semibold text-slate-600 dark:text-slate-300">רובריקות לשימוש חוזר</p>
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setTitle(p.title)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-brand-300 hover:text-brand-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                >
                  <Bookmark size={12} /> {p.title}
                </button>
              ))}
            </div>
          </>
        )}

        <label className="mb-1 mt-3 block text-sm font-semibold text-slate-600 dark:text-slate-300">שיוך</label>
        <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="ALL">כל העובדים</option>
          <option value="TEAM">צוות המשמרת</option>
          <option value="EMPLOYEE">עובד ספציפי</option>
        </select>
        {scope === "EMPLOYEE" && (
          <select className={`${inputClass} mt-2`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— בחר/י עובד —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}

        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 px-5 py-2.5 text-sm font-bold text-white shadow-glow transition hover:brightness-110 disabled:opacity-60"
          >
            <Send size={16} /> שליחה ושיוך
          </button>
          <button
            type="button"
            onClick={savePreset}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/60"
          >
            <Plus size={15} /> שמירה לרובריקה
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
          <ListChecks size={16} /> משימות שנשלחו
        </h2>
        {tasks.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400 dark:border-slate-700">
            אין משימות עדיין.
          </p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((t, i) => (
              <li
                key={t.id}
                style={{ "--i": i } as React.CSSProperties}
                className="animate-stagger flex items-center justify-between gap-3 rounded-xl border border-slate-200/80 bg-white/80 p-3 shadow-soft backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/70"
              >
                <div className="min-w-0">
                  <p className={`font-semibold ${t.status === "DONE" ? "text-slate-400 line-through dark:text-slate-500" : "text-slate-800 dark:text-slate-100"}`}>
                    {t.title}
                  </p>
                  <p className="text-xs text-slate-400">
                    {t.assigneeScope === "EMPLOYEE" ? t.employeeName ?? "עובד" : SCOPE_LABEL[t.assigneeScope]}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => markDone(t)}
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
                    t.status === "DONE"
                      ? "bg-green-50 text-green-600 dark:bg-green-500/15 dark:text-green-400"
                      : "bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300"
                  }`}
                >
                  {t.status === "DONE" ? <Check size={13} /> : <Clock size={13} />}
                  {t.status === "DONE" ? "בוצע" : "ממתין"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─────────────────────── טאב נהלי משמרת ───────────────────────
function ProceduresTab({ employees }: { employees: Employee[] }) {
  const [type, setType] = useState<"OPEN" | "CLOSE">("OPEN");
  const [scope, setScope] = useState<"ALL" | "TEAM" | "EMPLOYEE">("ALL");
  const [employeeId, setEmployeeId] = useState("");
  const [itemsText, setItemsText] = useState("");
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const p = await fetch("/api/procedures").then((r) => (r.ok ? r.json() : []));
    setProcedures(p);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setError("");
    const items = itemsText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) return setError("יש להזין סעיף אחד לפחות");
    if (scope === "EMPLOYEE" && !employeeId) return setError("יש לבחור עובד");
    setBusy(true);
    try {
      const res = await fetch("/api/procedures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, assigneeScope: scope, employeeId: scope === "EMPLOYEE" ? employeeId : null, items }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error ?? "שגיאה");
      setItemsText("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 shadow-card backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/70 sm:p-5">
        <h2 className="mb-3 text-base font-bold text-slate-800 dark:text-slate-100">נוהל משמרת חדש</h2>
        <label className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">סוג</label>
        <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="OPEN">פתיחת משמרת</option>
          <option value="CLOSE">סגירת משמרת</option>
        </select>

        <label className="mb-1 mt-3 block text-sm font-semibold text-slate-600 dark:text-slate-300">שיוך</label>
        <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="ALL">כל העובדים</option>
          <option value="TEAM">צוות המשמרת</option>
          <option value="EMPLOYEE">עובד ספציפי</option>
        </select>
        {scope === "EMPLOYEE" && (
          <select className={`${inputClass} mt-2`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— בחר/י עובד —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        )}

        <label className="mb-1 mt-3 block text-sm font-semibold text-slate-600 dark:text-slate-300">סעיפים (שורה = סעיף)</label>
        <textarea
          className={`${inputClass} min-h-28`}
          value={itemsText}
          onChange={(e) => setItemsText(e.target.value)}
          placeholder={"בדיקת קופה\nהדלקת מקררים\nבדיקת מלאי"}
        />

        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 px-5 py-2.5 text-sm font-bold text-white shadow-glow transition hover:brightness-110 disabled:opacity-60"
        >
          <Plus size={16} /> יצירת נוהל ושיוך
        </button>
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
          <ClipboardList size={16} /> נהלים שנוצרו
        </h2>
        {procedures.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400 dark:border-slate-700">
            אין נהלים עדיין.
          </p>
        ) : (
          <ul className="space-y-2">
            {procedures.map((p) => (
              <li key={p.id} className="rounded-xl border border-slate-200/80 bg-white/80 p-3 shadow-soft backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/70">
                <p className="mb-1 font-bold text-slate-800 dark:text-slate-100">
                  {p.type === "OPEN" ? "פתיחת משמרת" : "סגירת משמרת"}
                  <span className="mr-2 text-xs font-normal text-slate-400">{SCOPE_LABEL[p.assigneeScope]}</span>
                </p>
                <ul className="list-inside list-disc space-y-0.5 text-sm text-slate-600 dark:text-slate-300">
                  {p.items.map((it, idx) => (
                    <li key={idx}>{it}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
