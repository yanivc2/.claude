import { ChangePassword } from "@/components/ChangePassword";
import { UserManagement } from "@/components/UserManagement";
import { currentAdmin } from "@/lib/session";
import { ensureAdmin } from "@/lib/admin";

export const metadata = { title: "הגדרות" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // מבטיח שהבעלים מסומן (נרמול חד-פעמי) גם כשהסשן הקיים נוצר לפני התוספת.
  await ensureAdmin();
  const me = await currentAdmin();

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100">הגדרות</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">ניהול חשבון ואבטחה.</p>
      </header>
      <ChangePassword />
      {/* ניהול משתמשים — מוצג לבעל המערכת בלבד. */}
      {me?.isOwner && <UserManagement />}
    </div>
  );
}
