import { ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/LoginForm";
import { getAuthConfig } from "@/lib/auth";

export const metadata = { title: { absolute: "כניסה — מערכת משאבי אנוש" } };

export default function LoginPage() {
  const { usingDefaults } = getAuthConfig();
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 dark:bg-slate-950 px-4">
      {/* רקע עדין — הילות מותג רכות (לא בוהק), למצב בהיר וכהה */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 right-1/4 h-80 w-80 rounded-full bg-brand-200/40 blur-3xl dark:bg-brand-500/10"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 left-1/4 h-80 w-80 rounded-full bg-indigo-200/40 blur-3xl dark:bg-brand-700/10"
      />

      <div className="relative z-10 w-full max-w-sm">
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 p-7 shadow-xl shadow-slate-900/5 backdrop-blur">
          <div className="mb-7 flex flex-col items-center text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-light.png"
              alt="לוגו"
              width={76}
              height={76}
              className="rounded-2xl shadow-lg shadow-brand-600/15 ring-1 ring-slate-200 dark:ring-slate-700"
            />
            <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
              מערכת משאבי אנוש
            </h1>
            <p className="mt-1.5 max-w-[17rem] text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              קליטה, שימור וניהול זכויות עובדים — במקום אחד
            </p>
          </div>
          <LoginForm />
          {usingDefaults && (
            <p className="mt-4 rounded-lg bg-amber-50 dark:bg-amber-500/15 p-3 text-xs text-amber-800 dark:text-amber-300">
              ⚠️ לאבטחה מלאה יש להגדיר ב-Vercel את המשתנה <b>SESSION_SECRET</b> (מחרוזת אקראית
              ארוכה). אם עדיין לא הוגדרה סיסמה — הכניסה הראשונית היא <b>yanivc2 / admin</b>, ומומלץ
              לשנות אותה מיד ב&ldquo;הגדרות&rdquo;.
            </p>
          )}
        </div>
        {/* חתימת אמון */}
        <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
          <ShieldCheck size={14} />
          התחברות מאובטחת בהצפנה
        </p>
      </div>
    </div>
  );
}
