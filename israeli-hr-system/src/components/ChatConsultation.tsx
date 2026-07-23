"use client";

import { useEffect, useRef, useState } from "react";
import { Scale, Mic, Send, Sparkles } from "lucide-react";

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
  onstart: () => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const DISCLAIMER =
  'המידע כללי בלבד, מבוסס על "כל זכות", ואינו מהווה תחליף לייעוץ משפטי פרטני. אין להסתמך עליו כראיה משפטית.';

// שאלות לדוגמה — לחיצה ממלאת את שדה הקלט.
const SUGGESTIONS = [
  "כמה ימי הודעה מוקדמת מגיעים לעובד עם שנתיים ותק?",
  "מה גובה דמי ההבראה השנתיים?",
  "מתי חובה לפתוח קרן פנסיה לעובד חדש?",
  "כמה ימי חופשה בשנה מגיעים במשרה מלאה?",
];

// ממשק צ'אט להתייעצות על זכויות וחוקי עבודה. שולח שאלות ל-API מבוסס RAG.
export function ChatConsultation({ heightClass = "h-[70vh]" }: { heightClass?: string } = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // הטקסט שהיה בשדה כשהתחילה ההקלטה — התמלול מתווסף אליו.
  const baseInputRef = useRef("");

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
    rec.interimResults = true; // משוב חי תוך כדי דיבור
    rec.continuous = true; // ממשיך להקשיב עד עצירה ידנית
    rec.onresult = (e) => {
      // בונים מחדש את כל התמלול מכל התוצאות שנצברו — אמין וללא כפילויות.
      let text = "";
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i]?.[0]?.transcript ?? "";
      }
      const base = baseInputRef.current;
      setInput(base ? `${base} ${text}`.trim() : text.trim());
    };
    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
  }, []);

  function toggleMic() {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (listening) {
      rec.stop(); // מסיים ומתמלל את מה שנקלט (onend יעדכן את הסטטוס)
    } else {
      baseInputRef.current = input;
      try {
        rec.start();
      } catch {
        // כבר פעיל — מתעלמים.
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
    <div className={`flex ${heightClass} flex-col overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm`}>
      <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <span className="grid h-16 w-16 place-items-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
              <Scale size={30} />
            </span>
            <p className="mt-4 text-lg font-bold text-slate-700 dark:text-slate-200">
              שאל/י שאלה על זכויות וחוקי עבודה
            </p>
            <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">
              בחר/י אחת מהשאלות הנפוצות למטה, או הקלד/י שאלה משלך.
            </p>
            <div className="mt-5 flex max-w-lg flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setInput(q)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-500/10 dark:hover:text-brand-300"
                >
                  <Sparkles size={13} className="text-brand-400" />
                  {q}
                </button>
              ))}
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
                m.role === "user" ? "bg-brand-600 text-white" : "bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100"
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
                <p className="mt-3 border-t border-slate-300/40 pt-2 text-xs italic text-slate-500 dark:text-slate-400">
                  {DISCLAIMER}
                </p>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-end">
            <div className="flex items-center gap-1.5 rounded-2xl bg-slate-100 dark:bg-slate-800 px-4 py-4">
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400" />
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={send}
        className="flex items-center gap-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 p-3 sm:p-4"
      >
        {speechSupported && (
          <button
            type="button"
            onClick={toggleMic}
            aria-label={listening ? "עצירת הקלטה" : "דיבור"}
            title={listening ? "עצירת הקלטה" : "דיבור (הקלטה קולית)"}
            className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl transition ${
              listening
                ? "animate-pulse bg-red-500 text-white"
                : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
            }`}
          >
            <Mic size={19} />
          </button>
        )}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={listening ? "מקשיב... דבר/י עכשיו" : "הקלד/י שאלה..."}
          className="min-w-0 flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 text-base outline-none transition focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          aria-label="שליחה"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-md shadow-brand-600/20 transition hover:brightness-105 disabled:opacity-50 sm:h-auto sm:w-auto sm:px-5 sm:py-2.5"
        >
          <Send size={18} className="sm:hidden" />
          <span className="hidden text-base font-bold sm:inline">שליחה</span>
        </button>
      </form>
    </div>
  );
}
