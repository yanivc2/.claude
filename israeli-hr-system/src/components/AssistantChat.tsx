"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, Loader2 } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "מתי דני כהן התחיל לעבוד?",
  "כמה ימי הודעה מוקדמת מגיעים לעובד עם שנה ותק?",
  "כמה עובדים פעילים יש לי?",
  "איך מנפיקים הזמנה לשימוע?",
];

export function AssistantChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || loading) return;
    setError("");
    const history = messages;
    const next = [...messages, { role: "user" as const, content: question }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error ?? "שגיאה");
      setMessages((prev) => [...prev, { role: "assistant", content: b.answer ?? "" }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-[72vh] flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white/80 shadow-card backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/70">
      {/* אזור ההודעות */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="mx-auto mt-6 max-w-md text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-accent-600 text-white shadow-glow">
              <Sparkles size={22} />
            </span>
            <h2 className="mt-3 text-base font-bold text-slate-800 dark:text-slate-100">עוזר המערכת</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              שאל/י על עובדים, ותק, הודעה מוקדמת, משימות — או איך משתמשים במסך מסוים.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-brand-300 hover:text-brand-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-gradient-to-br from-brand-500 to-accent-600 text-white"
                  : "border border-slate-200 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-end">
            <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
              <Loader2 size={15} className="animate-spin" /> חושב…
            </div>
          </div>
        )}
        {error && <p className="text-center text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div ref={endRef} />
      </div>

      {/* קלט */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex items-center gap-2 border-t border-slate-200 p-3 dark:border-slate-800"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="שאל/י שאלה…"
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-base outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900 sm:text-sm"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 px-4 py-2.5 text-sm font-bold text-white shadow-glow transition hover:brightness-110 disabled:opacity-60"
        >
          <Send size={16} /> שליחה
        </button>
      </form>
      <p className="px-3 pb-2 text-center text-[11px] text-slate-400">
        עוזר קריאה בלבד — אינו מבצע פעולות. מידע משפטי דרך "יועץ לזכויות עובדים".
      </p>
    </div>
  );
}
