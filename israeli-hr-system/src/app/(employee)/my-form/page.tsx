import Link from "next/link";
import { FileText, CheckCircle2, Clock } from "lucide-react";
import { currentEmployee } from "@/lib/session";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "טופס 101 שלי" };

function fmtDate(d: Date | null | undefined): string {
  return d ? new Date(d).toLocaleDateString("he-IL") : "—";
}

// תצוגת טופס 101 של העובד (לקריאה בלבד) — הפרטים שמסר בקליטה.
export default async function MyFormPage() {
  const me = await currentEmployee();
  if (!me) return null;

  const form = await prisma.form101.findUnique({ where: { employeeId: me.id } });

  return (
    <div className="space-y-5 py-2">
      <div className="flex items-center gap-2.5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500/15 to-accent-500/15 text-brand-600 dark:text-accent-300">
          <FileText size={20} />
        </span>
        <h1 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">טופס 101 שלי</h1>
      </div>

      {!form ? (
        <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <Clock size={28} className="mx-auto text-slate-300 dark:text-slate-600" />
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            עדיין לא מולא טופס 101. אם ביקשו ממך להשלים קליטה, יש להשלים את התהליך שנשלח אליך.
          </p>
        </div>
      ) : (
        <>
          <div
            className={`flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold ${
              form.signedAt
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                : "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
            }`}
          >
            {form.signedAt ? <CheckCircle2 size={18} /> : <Clock size={18} />}
            {form.signedAt ? `נחתם בתאריך ${fmtDate(form.signedAt)}` : "טרם נחתם"}
          </div>

          <dl className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white/70 backdrop-blur dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900/60">
            {[
              ["שנת מס", String(form.taxYear)],
              ["מצב משפחתי", form.maritalStatus || "—"],
              ["מספר ילדים", String(form.numberOfChildren)],
              ["תושב ישראל", form.isResidentOfIsrael ? "כן" : "לא"],
              ["הכנסה נוספת", form.hasOtherIncome ? "כן" : "לא"],
              ["בקשת נקודות זיכוי", form.requestsCredits ? "כן" : "לא"],
              ["בנק", form.bankName || "—"],
              ["סניף", form.bankBranch || "—"],
              ["חשבון", form.bankAccount || "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 px-4 py-3">
                <dt className="text-sm text-slate-500 dark:text-slate-400">{k}</dt>
                <dd className="text-sm font-semibold text-slate-800 dark:text-slate-100">{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      <p className="text-center text-xs text-slate-400">
        לשינוי פרטים יש לפנות למעסיק.{" "}
        <Link href="/my-home" className="underline">
          חזרה
        </Link>
      </p>
    </div>
  );
}
