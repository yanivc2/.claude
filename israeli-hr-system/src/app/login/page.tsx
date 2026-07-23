import { LoginForm } from "@/components/LoginForm";
import { getAuthConfig } from "@/lib/auth";

export const metadata = { title: { absolute: "כניסה — מערכת משאבי אנוש" } };

export default function LoginPage() {
  const { usingDefaults } = getAuthConfig();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-sm">
        <div className="mb-5 flex flex-col items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-light.png"
            alt="לוגו"
            width={64}
            height={64}
            className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-700"
          />
          <p className="text-sm font-bold text-slate-700 dark:text-slate-200">מערכת משאבי אנוש</p>
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
