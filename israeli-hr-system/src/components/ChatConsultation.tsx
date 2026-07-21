"use client";

import { useEffect, useRef, useState } from "react";

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

// טיפוסים מינימליים ל-Web Speech API (אינם חלק מ-lib.dom הסטנדרטי).
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const DISCLAIMER =
  'ℹ️ המידע כללי בלבד, מבוסס על "כל זכות", ואינו מהווה תחליף לייעוץ משפטי פרטני. אין להסתמך עליו כראיה משפטית.';

// ממשק צ'אט להתייעצות על זכויות וחוקי עבודה. שולח שאלות ל-API מבוסס RAG.
export function ChatConsultation() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    setSpeechSupported(true);
    const rec = new Ctor();
    rec.lang = "he-IL";
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const transcript = e.results?.[0]?.[0]?.transcript ?? "";
      if (transcript) setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
  }, []);

  function toggleMic() {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (listening) {
      rec.stop();
      setListening(false);
    } else {
      try {
        rec.start();
        setListening(true);
      } catch {
        setListening(false);
      }
    }
  }

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
      <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-center text-slate-400">
            <div>
              <p className="text-3xl">💬</p>
              <p className="mt-2 text-base">שאל/י שאלה על זכויות וחוקי עבודה בישראל.</p>
              <p className="mt-1 text-sm">
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
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-base ${
                m.role === "user" ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-800"
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
                          <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="underline">
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
              {m.role === "assistant" && (
                <p className="mt-3 border-t border-slate-300/40 pt-2 text-xs italic text-slate-500">
                  {DISCLAIMER}
                </p>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-end">
            <div className="rounded-2xl bg-slate-100 px-4 py-3 text-base text-slate-500">
              מנסח תשובה...
            </div>
          </div>
        )}
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-slate-200 p-4">
        {speechSupported && (
          <button
            type="button"
            onClick={toggleMic}
            aria-label={listening ? "עצירת הקלטה" : "דיבור"}
            title={listening ? "עצירת הקלטה" : "דיבור (הקלטה קולית)"}
            className={`shrink-0 rounded-lg px-4 py-2 text-lg transition ${
              listening
                ? "animate-pulse bg-red-500 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            🎤
          </button>
        )}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={listening ? "מקשיב... דבר/י עכשיו" : "הקלד/י שאלה..."}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-4 py-2 text-base outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="shrink-0 rounded-lg bg-brand-600 px-5 py-2 text-base font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          שליחה
        </button>
      </form>
    </div>
  );
}
