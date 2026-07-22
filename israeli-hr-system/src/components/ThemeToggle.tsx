"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

// מתג מצב כהה/בהיר. שומר את הבחירה ב-localStorage; מוחל על <html> דרך class="dark".
// המצב הראשוני נקבע בסקריפט שב-layout (מונע הבהוב).
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // localStorage חסום — לא קריטי.
    }
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-100"
    >
      {dark ? <Sun size={20} className="opacity-90" /> : <Moon size={20} className="opacity-90" />}
      <span>{dark ? "מצב בהיר" : "מצב כהה"}</span>
    </button>
  );
}
