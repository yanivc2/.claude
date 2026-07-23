"use client";

import { useState } from "react";
import { Scale, X, MessageCircle } from "lucide-react";
import { ChatConsultation } from "./ChatConsultation";

// כפתור צף (פינה ימנית תחתונה) שפותח את "יועץ לזכויות עובדים" כחלון קטן,
// זמין בכל עמודי המערכת.
export function ChatWidget() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-4 z-50 w-[92vw] max-w-md sm:right-6">
          <div className="flex items-center justify-between rounded-t-2xl bg-gradient-to-br from-brand-500 to-brand-700 px-4 py-3 text-white shadow-lg">
            <span className="flex items-center gap-2 font-bold">
              <Scale size={18} />
              יועץ לזכויות עובדים
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="סגירה"
              className="grid h-8 w-8 place-items-center rounded-lg transition hover:bg-white/20"
            >
              <X size={18} />
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
        className="fixed bottom-6 right-6 z-50 grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-xl shadow-brand-500/30 transition hover:brightness-105 active:scale-95"
      >
        {open ? <X size={26} /> : <MessageCircle size={26} />}
      </button>
    </>
  );
}
