import { ChangePassword } from "@/components/ChangePassword";

export const metadata = { title: "הגדרות" };

export default function SettingsPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">הגדרות</h1>
        <p className="mt-1 text-sm text-slate-500">ניהול חשבון ואבטחה.</p>
      </header>
      <ChangePassword />
    </div>
  );
}
