import { LoginForm } from "@/components/LoginForm";
import { getAuthConfig } from "@/lib/auth";

export const metadata = { title: { absolute: "כניסה — מערכת משאבי אנוש" } };

export default function LoginPage() {
  const { usingDefaults } = getAuthConfig();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-7 shadow-xl shadow-slate-900/5">
        <div className="mb-7 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-light.png"
            alt="לוגו"
            width={72}
            height={72}
            className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-700"
          />
          <h1 className="mt-4 text-xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
            מערכת משאבי אנוש
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">כניסה למערכת</p>
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
  );
}
