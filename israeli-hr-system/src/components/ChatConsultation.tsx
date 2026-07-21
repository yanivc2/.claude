"use client";

import { useState } from "react";

interface Citation {
  title: string;
  source: string;
  sourceUrl: string | null;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

// ממשק צ'אט להתייעצות על זכויות וחוקי עבודה. שולח שאלות ל-API מבוסס RAG.
export function ChatConsultation() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    const next = [...messages, { role: "user" as const, content: question }];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/consultation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      const data = await res.json();
      setMessages([
        ...next,
        {
          role: "assistant",
          content: data.answer ?? "אירעה שגיאה בקבלת התשובה.",
          citations: data.citations,
        },
      ]);
    } catch {
      setMessages([
        ...next,
        { role: "assistant", content: "אירעה שגיאה בחיבור לשרת. נסה שוב." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-[70vh] flex-col rounded-xl border border-slate-200 bg-white">
      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-center text-sm text-slate-400">
            <div>
              <p className="text-3xl">💬</p>
              <p className="mt-2">שאל/י שאלה על זכויות וחוקי עבודה בישראל.</p>
              <p className="mt-1 text-xs">
                לדוגמה: &ldquo;כמה ימי הודעה מוקדמת מגיעים לעובד עם שנתיים ותק?&rdquo;
              </p>
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                m.role === "user"
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-800"
              }`}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.citations && m.citations.length > 0 && (
                <div className="mt-3 border-t border-slate-300/40 pt-2">
                  <p className="text-xs font-semibold">מקורות:</p>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {m.citations.map((c, j) => (
                      <li key={j}>
                        [{j + 1}]{" "}
                        {c.sourceUrl ? (
                          <a
                            href={c.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                          >
                            {c.title}
                          </a>
                        ) : (
                          c.title
                        )}{" "}
                        — {c.source}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-end">
            <div className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-500">
              מנסח תשובה...
            </div>
          </div>
        )}
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-slate-200 p-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="הקלד/י שאלה..."
          className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          שליחה
        </button>
      </form>
    </div>
  );
}
