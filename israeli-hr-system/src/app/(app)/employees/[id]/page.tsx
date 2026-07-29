import Link from "next/link";
import { ArrowRight, CalendarDays, Wallet, Clock, type LucideIcon } from "lucide-react";
import { prisma } from "@/lib/prisma";
import type { DocumentType, SignatureContext } from "@prisma/client";
import { EmployeeExport, type ExportData } from "@/components/EmployeeExport";
import { formatAvailability } from "@/lib/availability";
import { avatarColor, initials } from "@/lib/avatar";
import { currentAdmin } from "@/lib/session";
import { canAccessEmployeeRecord } from "@/lib/rbac";
import { CompanyAssign } from "@/components/CompanyAssign";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const emp = await prisma.employee
    .findUnique({ where: { id }, select: { firstName: true, lastName: true } })
    .catch(() => null);
  return { title: emp ? `${emp.firstName} ${emp.lastName}` : "תיק עובד" };
}

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });
const fmt = (d: Date | null | undefined) => (d ? dateFmt.format(d) : "—");
const yesNo = (b: boolean) => (b ? "כן" : "לא");

// ותק מחושב מתאריך תחילת העבודה (לתצוגה בלבד).
function tenure(start: Date | null | undefined): string {
  if (!start) return "—";
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  if (months < 0) return "—";
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0 && m === 0) return "פחות מחודש";
  const parts: string[] = [];
  if (y > 0) parts.push(y === 1 ? "שנה" : `${y} שנים`);
  if (m > 0) parts.push(m === 1 ? "חודש" : `${m} חודשים`);
  return parts.join(" ו-");
}

// אריח נתון מודגש (סטטיסטיקה מרכזית בראש התיק).
function StatTile({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
        <Icon size={19} />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
        <p className="truncate text-base font-bold text-slate-800 dark:text-slate-100">{value}</p>
      </div>
    </div>
  );
}

const STATUS: Record<string, { label: string; cls: string }> = {
  ONBOARDING: { label: "בתהליך קליטה", cls: "bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  ACTIVE: { label: "פעיל", cls: "bg-green-50 dark:bg-green-500/15 text-green-700 dark:text-green-400" },
  NOTICE_PERIOD: { label: "בהודעה מוקדמת", cls: "bg-orange-50 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300" },
  INACTIVE: { label: "לא פעיל", cls: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400" },
  TERMINATED: { label: "סיום העסקה", cls: "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400" },
};

const DOC_LABELS: Record<DocumentType, string> = {
  ID_CARD: "ספח תעודת זהות",
  CONTRACT: "הסכם עבודה",
  FORM_101: "טופס 101",
  HEARING_INVITATION: "הזמנה לשימוע",
  TERMINATION_LETTER: "מכתב סיום העסקה",
  OTHER: "מסמך",
};

const SIG_LABELS: Record<SignatureContext, string> = {
  CONTRACT: "חתימה על הסכם עבודה",
  FORM_101: "חתימה על טופס 101",
  HEARING: "אישור זימון לשימוע",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-sm sm:p-6">
      <h2 className="mb-3 text-base font-bold text-slate-800 dark:text-slate-100">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 border-b border-slate-100 dark:border-slate-800 py-1">
          <dt className="text-sm text-slate-500 dark:text-slate-400">{k}</dt>
          <dd className="text-sm font-medium text-slate-800 dark:text-slate-100">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const me = await currentAdmin();
  const emp = await prisma.employee
    .findUnique({
      where: { id },
      include: {
        form101: true,
        documents: true,
        signatures: true,
        pensionTask: true,
        surveys: { orderBy: { scheduledFor: "asc" } },
        company: { select: { name: true } },
      },
    })
    .catch(() => null);

  // הפרדה מולטי-חברה: מנהל חנות אינו רשאי לצפות בעובד מחברה אחרת (מונע IDOR).
  const denied = !!emp && !!me && !canAccessEmployeeRecord(me, emp.companyId);

  if (!emp || denied) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-4xl">⚠️</p>
        <h1 className="mt-4 text-xl font-bold text-slate-800 dark:text-slate-100">העובד לא נמצא</h1>
        <Link href="/employees" className="mt-4 inline-block text-sm text-brand-700 dark:text-brand-300 underline">
          חזרה לרשימת העובדים
        </Link>
      </div>
    );
  }

  const fullName = `${emp.firstName} ${emp.lastName}`;

  const personalRows: [string, string][] = [
    ["תעודת זהות", emp.nationalId],
    ["דוא״ל", emp.email],
    ["טלפון", emp.phone || "—"],
    ["כתובת", emp.address || "—"],
    ["תאריך לידה", fmt(emp.birthDate)],
  ];
  const employmentRows: [string, string][] = [
    ["תפקיד", emp.jobTitle || "—"],
    ["תחילת עבודה", fmt(emp.startDate)],
    ["שכר חודשי", emp.monthlySalary ? `${emp.monthlySalary} ₪` : "—"],
    ["שכר שעתי", emp.hourlySalary ? `${emp.hourlySalary} ₪` : "—"],
    ["זמינות", formatAvailability(emp.availability)],
    ["הסדר פנסיוני פעיל בקליטה", yesNo(emp.hasActivePension)],
    ["אישור מדיניות פרטיות", emp.privacyAcceptedAt ? fmt(emp.privacyAcceptedAt) : "—"],
  ];
  const form101Rows: [string, string][] | null = emp.form101
    ? [
        ["שנת מס", String(emp.form101.taxYear)],
        ["מצב משפחתי", emp.form101.maritalStatus || "—"],
        ["מספר ילדים", String(emp.form101.numberOfChildren)],
        ["תושב/ת ישראל", yesNo(emp.form101.isResidentOfIsrael)],
        ["הכנסה נוספת", yesNo(emp.form101.hasOtherIncome)],
        ["בקשת נקודות זיכוי", yesNo(emp.form101.requestsCredits)],
      ]
    : null;
  const pensionRows: [string, string][] | null = emp.pensionTask
    ? [
        ["מועד יעד לפתיחת תיק", fmt(emp.pensionTask.dueDate)],
        ["סטטוס", emp.pensionTask.status === "DONE" ? "טופל" : "ממתין"],
        ["בסיס", emp.pensionTask.basis],
      ]
    : null;

  // הרכבת נתוני הייצוא (כולל data URLs של מסמכים וחתימות).
  const exportData: ExportData = {
    fullName,
    sections: [
      { title: "פרטים אישיים", rows: personalRows },
      { title: "פרטי העסקה", rows: employmentRows },
      ...(form101Rows ? [{ title: "טופס 101", rows: form101Rows }] : []),
      ...(pensionRows ? [{ title: "תיק פנסיה", rows: pensionRows }] : []),
    ],
    documents: emp.documents.map((d) => ({
      title: DOC_LABELS[d.type],
      fileName: d.fileName,
      mimeType: d.mimeType || "",
      dataUrl: d.fileUrl,
    })),
    signatures: emp.signatures.map((s) => ({
      label: SIG_LABELS[s.context],
      dataUrl: s.imageData,
    })),
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/employees"
          className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 dark:text-slate-400 transition hover:text-brand-600"
        >
          <ArrowRight size={14} />
          חזרה לרשימת העובדים
        </Link>
      </div>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gradient-to-br text-base font-bold text-white ${avatarColor(
              emp.firstName + emp.lastName,
            )}`}
          >
            {initials(emp.firstName, emp.lastName)}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
                {fullName}
              </h1>
              {STATUS[emp.status] && (
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS[emp.status].cls}`}
                >
                  {STATUS[emp.status].label}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {emp.jobTitle || "עובד/ת"} · התחלה {fmt(emp.startDate)}
            </p>
          </div>
        </div>
        <EmployeeExport data={exportData} />
      </header>

      {/* שיוך חברה — בסיס ההפרדה המולטי-חברה (עריכה לבעלים/מזכירה) */}
      <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
        <CompanyAssign employeeId={emp.id} companyId={emp.companyId} companyName={emp.company?.name ?? null} />
      </div>

      {/* אריחי נתונים מרכזיים — היררכיה ויזואלית בראש התיק */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile icon={CalendarDays} label="תחילת עבודה" value={fmt(emp.startDate)} />
        <StatTile icon={Clock} label="ותק" value={tenure(emp.startDate)} />
        <StatTile
          icon={Wallet}
          label="שכר"
          value={
            emp.monthlySalary
              ? `${emp.monthlySalary.toLocaleString("he-IL")} ₪ לחודש`
              : emp.hourlySalary
                ? `${emp.hourlySalary.toLocaleString("he-IL")} ₪ לשעה`
                : "—"
          }
        />
      </div>

      <Card title="פרטים אישיים">
        <Rows rows={personalRows} />
      </Card>

      <Card title="פרטי העסקה">
        <Rows rows={employmentRows} />
      </Card>

      {pensionRows && (
        <Card title="תיק פנסיה">
          <Rows rows={[pensionRows[0], pensionRows[1]]} />
          <p className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            {emp.pensionTask!.basis}
          </p>
        </Card>
      )}

      {form101Rows && (
        <Card title="טופס 101">
          <Rows rows={form101Rows} />
        </Card>
      )}

      <Card title="מסמכים">
        {emp.documents.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-slate-400">לא צורפו מסמכים.</p>
        ) : (
          <div className="space-y-4">
            {emp.documents.map((d) => {
              const isPdf = (d.mimeType || "").includes("pdf");
              return (
                <div key={d.id}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {DOC_LABELS[d.type]}: {d.fileName}
                    </span>
                    <a
                      href={d.fileUrl}
                      download={d.fileName}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1 text-xs text-slate-600 dark:text-slate-300 transition hover:bg-slate-50 dark:hover:bg-slate-800/60"
                    >
                      הורדה
                    </a>
                  </div>
                  {isPdf ? (
                    <iframe
                      src={d.fileUrl}
                      title={d.fileName}
                      className="h-96 w-full rounded-lg border border-slate-200 dark:border-slate-800"
                    />
                  ) : (
                    <img
                      src={d.fileUrl}
                      alt={d.fileName}
                      className="max-h-96 w-full rounded-lg border border-slate-200 dark:border-slate-800 object-contain"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="חתימות">
        {emp.signatures.length === 0 ? (
          <p className="text-sm text-slate-400 dark:text-slate-400">אין חתימות.</p>
        ) : (
          <div className="flex flex-wrap gap-6">
            {emp.signatures.map((s) => (
              <div key={s.id}>
                <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">{SIG_LABELS[s.context]}</p>
                <img
                  src={s.imageData}
                  alt={SIG_LABELS[s.context]}
                  className="h-24 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2"
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
