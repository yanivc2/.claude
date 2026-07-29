import { ContactsManager } from "@/components/ContactsManager";

export const metadata = { title: "אנשי קשר" };
export const dynamic = "force-dynamic";

export default function ContactsPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
          אנשי קשר ומטפלי פנסיה
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          ניהול אנשי קשר ומטפלים בתיקי הפנסיה — כדי שתוכל/י לשלוח להם מסמכים במייל או
          בוואטסאפ ישירות מתוך תיק העובד.
        </p>
      </header>
      <ContactsManager />
    </div>
  );
}
