"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Check,
  Clock,
  Send,
  Bookmark,
  ClipboardList,
  ListChecks,
  X,
  Pencil,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { PROCEDURE_TYPES, procedureTypeLabel } from "@/lib/procedure-types";

interface Employee {
  id: string;
  name: string;
}
interface Task {
  id: string;
  title: string;
  assigneeScope: "ALL" | "TEAM" | "EMPLOYEE";
  employeeName: string | null;
  employeeNames: string[];
  status: "SENT" | "DONE";
  createdAt: string;
}
interface Preset {
  id: string;
  title: string;
}
interface Procedure {
  id: string;
  type: string;
  assigneeScope: "ALL" | "TEAM" | "EMPLOYEE";
  employeeIdList: string[];
  employeeNames: string[];
  items: string[];
  createdAt: string;
}

const inputClass =
  "w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-base sm:text-sm outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

const SCOPE_LABEL = { ALL: "כל העובדים", TEAM: "צוות המשמרת", EMPLOYEE: "עובדים ספציפיים" } as const;

// תווית שיוך לתצוגה — לעובדים ספציפיים מציגה את השמות.
function assigneeText(scope: "ALL" | "TEAM" | "EMPLOYEE", names: string[]): string {
  if (scope === "EMPLOYEE") return names.length ? names.join(", ") : "עובדים";
  return SCOPE_LABEL[scope];
}

export function TasksManager({
  employees: initialEmployees,
  canManageEmployees,
}: {
  employees: Employee[];
  canManageEmployees: boolean;
}) {
  const [tab, setTab] = useState<"tasks" | "procedures">("tasks");
  const [employees, setEmployees] = useState<Employee[]>(initialEmployees);

  // רענון רשימת העובדים (למשל אחרי הקמת עובד חדש).
  const refreshEmployees = useCallback(async () => {
    const list = await fetch("/api/employees").then((r) => (r.ok ? r.json() : null));
    if (Array.isArray(list)) setEmployees(list);
  }, []);

  const shared = { employees, refreshEmployees, canManageEmployees };

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

      {tab === "tasks" ? <TasksTab {...shared} /> : <ProceduresTab {...shared} />}
    </div>
  );
}

// ─────────────────────── בחירת עובדים (רב) + הקמת עובד ───────────────────────
function EmployeePicker({
  employees,
  selected,
  onToggle,
  canManageEmployees,
  onAddClick,
}: {
  employees: Employee[];
  selected: string[];
  onToggle: (id: string) => void;
  canManageEmployees: boolean;
  onAddClick: () => void;
}) {
  return (
    <div className="mt-2 rounded-xl border border-slate-300 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
      {employees.length === 0 ? (
        <p className="px-1 py-2 text-sm text-slate-400">אין עדיין עובדים במערכת.</p>
      ) : (
        <div className="max-h-52 space-y-1 overflow-y-auto">
          {employees.map((e) => {
            const on = selected.includes(e.id);
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onToggle(e.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-right text-sm transition ${
                  on
                    ? "bg-brand-50 text-brand-800 dark:bg-brand-500/15 dark:text-brand-200"
                    : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                    on
                      ? "border-brand-500 bg-brand-500 text-white"
                      : "border-slate-300 dark:border-slate-600"
                  }`}
                >
                  {on && <Check size={13} />}
                </span>
                {e.name}
              </button>
            );
          })}
        </div>
      )}
      {canManageEmployees && (
        <button
          type="button"
          onClick={onAddClick}
          className="mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-brand-300 px-3 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 dark:border-brand-500/40 dark:text-brand-300 dark:hover:bg-brand-500/10"
        >
          <UserPlus size={15} /> הקמת עובד חדש
        </button>
      )}
    </div>
  );
}

// חלונית הקמת עובד מהירה — פרטי המינימום הדרושים לשיוך.
function QuickAddEmployee({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (emp: Employee) => void;
}) {
  const [form, setForm] = useState({ firstName: "", lastName: "", nationalId: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error ?? "שגיאה בהקמת העובד");
      onCreated({ id: b.id, name: b.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">הקמת עובד חדש</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input className={inputClass} placeholder="שם פרטי" value={form.firstName} onChange={set("firstName")} />
          <input className={inputClass} placeholder="שם משפחה" value={form.lastName} onChange={set("lastName")} />
        </div>
        <input className={`${inputClass} mt-2`} placeholder="תעודת זהות" value={form.nationalId} onChange={set("nationalId")} />
        <input className={`${inputClass} mt-2`} placeholder="דוא״ל" type="email" value={form.email} onChange={set("email")} />
        <input className={`${inputClass} mt-2`} placeholder="טלפון (רשות)" value={form.phone} onChange={set("phone")} />
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <p className="mt-2 text-xs text-slate-400">
          הקמה מהירה לצורך שיוך. קליטה מלאה (טופס 101, מסמכים) נעשית במסך קליטת העובד.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300"
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 px-5 py-2 text-sm font-bold text-white shadow-glow transition hover:brightness-110 disabled:opacity-60"
          >
            <UserPlus size={15} /> הקמה
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────── טאב משימות ───────────────────────
function TasksTab({
  employees,
  refreshEmployees,
  canManageEmployees,
}: {
  employees: Employee[];
  refreshEmployees: () => Promise<void>;
  canManageEmployees: boolean;
}) {
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"ALL" | "TEAM" | "EMPLOYEE">("ALL");
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

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

  const toggleEmp = (id: string) =>
    setEmployeeIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  async function send() {
    setError("");
    if (!title.trim()) return setError("יש להזין תיאור משימה");
    if (scope === "EMPLOYEE" && employeeIds.length === 0) return setError("יש לבחור עובד אחד לפחות");
    setBusy(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, assigneeScope: scope, employeeIds: scope === "EMPLOYEE" ? employeeIds : [] }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error ?? "שגיאה");
      setTitle("");
      setEmployeeIds([]);
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

  async function deletePreset(id: string) {
    await fetch(`/api/task-presets/${id}`, { method: "DELETE" }).catch(() => {});
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

  async function saveEdit(id: string) {
    if (!editValue.trim()) return;
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: editValue.trim() }),
    }).catch(() => {});
    setEditingId(null);
    await load();
  }

  async function deleteTask(id: string) {
    await fetch(`/api/tasks/${id}`, { method: "DELETE" }).catch(() => {});
    await load();
  }

  return (
    <div className="space-y-5">
      {showAdd && (
        <QuickAddEmployee
          onClose={() => setShowAdd(false)}
          onCreated={async (emp) => {
            setShowAdd(false);
            await refreshEmployees();
            setScope("EMPLOYEE");
            setEmployeeIds((ids) => [...ids, emp.id]);
          }}
        />
      )}
      <section className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 shadow-card backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/70 sm:p-5">
        <h2 className="mb-3 text-base font-bold text-slate-800 dark:text-slate-100">משימה חדשה</h2>
        <label className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">תיאור המשימה</label>
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="לדוגמה: פרונטים במעברים 3–5" />

        {presets.length > 0 && (
          <>
            <p className="mb-1 mt-3 text-sm font-semibold text-slate-600 dark:text-slate-300">רובריקות לשימוש חוזר</p>
            <div className="flex flex-wrap gap-2">
              {presets.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1.5 pr-3 pl-1.5 text-sm font-medium text-slate-700 shadow-soft dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                >
                  <button
                    type="button"
                    onClick={() => setTitle(p.title)}
                    className="inline-flex items-center gap-1.5 transition hover:text-brand-700 dark:hover:text-brand-300"
                  >
                    <Bookmark size={13} /> {p.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePreset(p.id)}
                    aria-label="מחיקת רובריקה"
                    className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/15"
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          </>
        )}

        <label className="mb-1 mt-3 block text-sm font-semibold text-slate-600 dark:text-slate-300">שיוך</label>
        <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="ALL">כל העובדים</option>
          <option value="TEAM">צוות המשמרת</option>
          <option value="EMPLOYEE">עובדים ספציפיים</option>
        </select>
        {scope === "EMPLOYEE" && (
          <EmployeePicker
            employees={employees}
            selected={employeeIds}
            onToggle={toggleEmp}
            canManageEmployees={canManageEmployees}
            onAddClick={() => setShowAdd(true)}
          />
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
                className="animate-stagger flex items-center justify-between gap-2 rounded-xl border border-slate-200/80 bg-white/80 p-3 shadow-soft backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/70"
              >
                {editingId === t.id ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      className={inputClass}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveEdit(t.id)}
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => saveEdit(t.id)}
                      className="shrink-0 rounded-lg bg-brand-500 px-3 py-2 text-sm font-bold text-white"
                    >
                      שמירה
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="shrink-0 rounded-lg px-2 py-2 text-sm text-slate-400 hover:text-slate-600"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="min-w-0">
                      <p className={`font-semibold ${t.status === "DONE" ? "text-slate-400 line-through dark:text-slate-500" : "text-slate-800 dark:text-slate-100"}`}>
                        {t.title}
                      </p>
                      <p className="text-xs text-slate-400">{assigneeText(t.assigneeScope, t.employeeNames)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => markDone(t)}
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold ${
                          t.status === "DONE"
                            ? "bg-green-50 text-green-600 dark:bg-green-500/15 dark:text-green-400"
                            : "bg-accent-50 text-accent-700 dark:bg-accent-500/15 dark:text-accent-300"
                        }`}
                      >
                        {t.status === "DONE" ? <Check size={13} /> : <Clock size={13} />}
                        {t.status === "DONE" ? "בוצע" : "ממתין"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(t.id);
                          setEditValue(t.title);
                        }}
                        aria-label="עריכה"
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteTask(t.id)}
                        aria-label="מחיקה"
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/15"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─────────────────────── טאב נהלי משמרת ───────────────────────
function ProceduresTab({
  employees,
  refreshEmployees,
  canManageEmployees,
}: {
  employees: Employee[];
  refreshEmployees: () => Promise<void>;
  canManageEmployees: boolean;
}) {
  const [type, setType] = useState<string>("OPEN");
  const [scope, setScope] = useState<"ALL" | "TEAM" | "EMPLOYEE">("ALL");
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [itemsText, setItemsText] = useState("");
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = await fetch("/api/procedures").then((r) => (r.ok ? r.json() : []));
    setProcedures(p);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const toggleEmp = (id: string) =>
    setEmployeeIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  function resetForm() {
    setEditingId(null);
    setType("OPEN");
    setScope("ALL");
    setEmployeeIds([]);
    setItemsText("");
    setError("");
  }

  async function submit() {
    setError("");
    const items = itemsText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) return setError("יש להזין סעיף אחד לפחות");
    if (scope === "EMPLOYEE" && employeeIds.length === 0) return setError("יש לבחור עובד אחד לפחות");
    setBusy(true);
    try {
      const url = editingId ? `/api/procedures/${editingId}` : "/api/procedures";
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, assigneeScope: scope, employeeIds: scope === "EMPLOYEE" ? employeeIds : [], items }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error ?? "שגיאה");
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(p: Procedure) {
    setEditingId(p.id);
    setType(p.type);
    setScope(p.assigneeScope);
    setEmployeeIds(p.employeeIdList);
    setItemsText(p.items.join("\n"));
    setError("");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteProcedure(id: string) {
    await fetch(`/api/procedures/${id}`, { method: "DELETE" }).catch(() => {});
    if (editingId === id) resetForm();
    await load();
  }

  return (
    <div className="space-y-5">
      {showAdd && (
        <QuickAddEmployee
          onClose={() => setShowAdd(false)}
          onCreated={async (emp) => {
            setShowAdd(false);
            await refreshEmployees();
            setScope("EMPLOYEE");
            setEmployeeIds((ids) => [...ids, emp.id]);
          }}
        />
      )}
      <section className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 shadow-card backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/70 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
            {editingId ? "עריכת נוהל משמרת" : "נוהל משמרת חדש"}
          </h2>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="text-sm font-semibold text-slate-400 hover:text-slate-600"
            >
              ביטול עריכה
            </button>
          )}
        </div>
        <label className="mb-1 block text-sm font-semibold text-slate-600 dark:text-slate-300">סוג</label>
        <select className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>
          {PROCEDURE_TYPES.map((t) => (
            <option key={t} value={t}>
              {procedureTypeLabel(t)}
            </option>
          ))}
        </select>

        <label className="mb-1 mt-3 block text-sm font-semibold text-slate-600 dark:text-slate-300">שיוך</label>
        <select className={inputClass} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="ALL">כל העובדים</option>
          <option value="TEAM">צוות המשמרת</option>
          <option value="EMPLOYEE">עובדים ספציפיים</option>
        </select>
        {scope === "EMPLOYEE" && (
          <EmployeePicker
            employees={employees}
            selected={employeeIds}
            onToggle={toggleEmp}
            canManageEmployees={canManageEmployees}
            onAddClick={() => setShowAdd(true)}
          />
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
          onClick={submit}
          disabled={busy}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 px-5 py-2.5 text-sm font-bold text-white shadow-glow transition hover:brightness-110 disabled:opacity-60"
        >
          <Plus size={16} /> {editingId ? "עדכון הנוהל" : "יצירת נוהל ושיוך"}
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
                <div className="mb-1 flex items-start justify-between gap-2">
                  <p className="font-bold text-slate-800 dark:text-slate-100">
                    {procedureTypeLabel(p.type)}
                    <span className="mr-2 inline-flex items-center gap-1 text-xs font-normal text-slate-400">
                      {p.assigneeScope === "EMPLOYEE" && <Users size={12} />}
                      {assigneeText(p.assigneeScope, p.employeeNames)}
                    </span>
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      aria-label="עריכה"
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteProcedure(p.id)}
                      aria-label="מחיקה"
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/15"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
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
