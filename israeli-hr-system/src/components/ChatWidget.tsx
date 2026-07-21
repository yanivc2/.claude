"use client";

import { useState } from "react";
import { ChatConsultation } from "./ChatConsultation";

// כפתור צף (פינה ימנית תחתונה) שפותח את "יועץ לזכויות עובדים" כחלון קטן,
// זמין בכל עמודי המערכת.
export function ChatWidget() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-4 z-50 w-[92vw] max-w-md sm:right-6">
          <div className="flex items-center justify-between rounded-t-xl bg-brand-600 px-4 py-3 text-white shadow-lg">
            <span className="font-semibold">💬 יועץ לזכויות עובדים</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="סגירה"
              className="rounded p-1 text-lg leading-none hover:bg-white/20"
            >
              ✕
            </button>
          </div>
          <div className="[&>div]:rounded-t-none">
            <ChatConsultation heightClass="h-[60vh]" />
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "סגירת היועץ" : "פתיחת יועץ לזכויות עובדים"}
        className="fixed bottom-6 right-6 z-50 flex h-16 w-16 items-center justify-center rounded-full bg-brand-600 text-3xl text-white shadow-xl transition hover:bg-brand-700"
      >
        {open ? "✕" : "💬"}
      </button>
    </>
  );
}
