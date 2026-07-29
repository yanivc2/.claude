import { ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/LoginForm";
import { getAuthConfig } from "@/lib/auth";

export const metadata = { title: { absolute: "כניסה — מערכת משאבי אנוש" } };

export default function LoginPage() {
  const { usingDefaults } = getAuthConfig();
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      {/* רקע חי — מארג הילות מותג נעות (אינדיגו + סגול), בהיר וכהה */}
      <div
        aria-hidden
        className="animate-float-slow pointer-events-none absolute -top-40 right-[15%] h-96 w-96 rounded-full bg-brand-400/30 blur-[90px] dark:bg-brand-500/20"
      />
      <div
        aria-hidden
        className="animate-float-slow-2 pointer-events-none absolute -bottom-40 left-[12%] h-[26rem] w-[26rem] rounded-full bg-accent-400/25 blur-[100px] dark:bg-accent-600/15"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/3 h-72 w-72 -translate-x-1/2 rounded-full bg-brand-300/20 blur-[80px] dark:bg-accent-500/10"
      />

      <div className="relative z-10 w-full max-w-sm animate-fade-up">
        {/* עטיפת גרדיאנט דקה שיוצרת מסגרת זוהרת סביב הכרטיס */}
        <div className="rounded-[1.65rem] bg-gradient-to-br from-brand-500/40 via-accent-500/20 to-transparent p-px shadow-glow">
          <div className="glass rounded-[1.6rem] p-7 sm:p-8">
            <div className="mb-7 flex flex-col items-center text-center">
              <div className="rounded-2xl bg-gradient-to-br from-brand-500 to-accent-600 p-[3px] shadow-lg shadow-brand-600/25">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/logo-light.png"
                  alt="לוגו"
                  width={72}
                  height={72}
                  className="rounded-[0.85rem] bg-white"
                />
              </div>
              <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-gradient">
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
