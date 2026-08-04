"use client";

import { useRef } from "react";
import { Camera, X } from "lucide-react";

// בורר קובץ ידידותי: כפתור ברור שמסביר את האפשרויות (צילום / גלריה / קובץ),
// ומאפשר גם להסיר קובץ שכבר נבחר. עוטף <input type="file"> מוסתר — כך שבאייפון
// הלחיצה פותחת את גיליון המקור (צלם תמונה / ספריית תמונות / בחר קובץ).
export function FilePicker({
  label = "צילום או בחירת קובץ",
  accept = "image/*,application/pdf",
  fileName,
  onFile,
  hint = "אפשר לצלם, לבחור מהגלריה או להעלות קובץ (תמונה / PDF)",
}: {
  label?: string;
  accept?: string;
  fileName: string | null;
  onFile: (file: File | null) => void;
  hint?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
      {fileName ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <span className="min-w-0 flex-1 truncate text-sm text-emerald-800 dark:text-emerald-200">
            📎 {fileName}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => ref.current?.click()}
              className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-700 transition hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-500/15"
            >
              החלפה
            </button>
            <button
              type="button"
              onClick={() => {
                onFile(null);
                if (ref.current) ref.current.value = "";
              }}
              aria-label="הסרת הקובץ"
              className="rounded-lg p-1.5 text-red-500 transition hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-500/15"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => ref.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-600 transition hover:border-brand-400 hover:text-brand-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          >
            <Camera size={18} /> {label}
          </button>
          {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
        </>
      )}
    </div>
  );
}
