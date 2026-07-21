import { LoginForm } from "@/components/LoginForm";
import { getAuthConfig } from "@/lib/auth";

export const metadata = { title: { absolute: "כניסה — מערכת משאבי אנוש" } };

export default function LoginPage() {
  const { usingDefaults } = getAuthConfig();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <LoginForm />
        {usingDefaults && (
          <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            ⚠️ לאבטחה מלאה יש להגדיר ב-Vercel את המשתנה <b>SESSION_SECRET</b> (מחרוזת אקראית
            ארוכה). אם עדיין לא הוגדרה סיסמה — הכניסה הראשונית היא <b>yanivc2 / admin</b>, ומומלץ
            לשנות אותה מיד ב&ldquo;הגדרות&rdquo;.
          </p>
        )}
      </div>
    </div>
  );
}
