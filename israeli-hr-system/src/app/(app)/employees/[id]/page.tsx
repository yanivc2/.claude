import Link from "next/link";
import { prisma } from "@/lib/prisma";
import type { DocumentType, SignatureContext } from "@prisma/client";
import { EmployeeExport, type ExportData } from "@/components/EmployeeExport";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" });
const fmt = (d: Date | null | undefined) => (d ? dateFmt.format(d) : "—");
const yesNo = (b: boolean) => (b ? "כן" : "לא");

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
    <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      <h2 className="mb-3 text-lg font-semibold text-slate-800">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 border-b border-slate-100 py-1">
          <dt className="text-sm text-slate-500">{k}</dt>
          <dd className="text-sm font-medium text-slate-800">{v}</dd>
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
  const emp = await prisma.employee
    .findUnique({
      where: { id },
      include: {
        form101: true,
        documents: true,
        signatures: true,
        pensionTask: true,
        surveys: { orderBy: { scheduledFor: "asc" } },
      },
    })
    .catch(() => null);

  if (!emp) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-4xl">⚠️</p>
        <h1 className="mt-4 text-xl font-bold text-slate-800">העובד לא נמצא</h1>
        <Link href="/employees" className="mt-4 inline-block text-sm text-brand-700 underline">
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
    ["מחלקה", emp.department || "—"],
    ["תחילת עבודה", fmt(emp.startDate)],
    ["שכר חודשי", emp.monthlySalary ? `${emp.monthlySalary} ₪` : "—"],
    ["הסדר פנסיוני פעיל בקליטה", yesNo(emp.hasActivePension)],
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
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link href="/employees" className="text-xs text-slate-500 hover:underline">
            ← חזרה לרשימת העובדים
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-slate-800">{fullName}</h1>
        </div>
        <EmployeeExport data={exportData} />
      </header>

      <Card title="פרטים אישיים">
        <Rows rows={personalRows} />
      </Card>

      <Card title="פרטי העסקה">
        <Rows rows={employmentRows} />
      </Card>

      {pensionRows && (
        <Card title="תיק פנסיה">
          <Rows rows={[pensionRows[0], pensionRows[1]]} />
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
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
          <p className="text-sm text-slate-400">לא צורפו מסמכים.</p>
        ) : (
          <div className="space-y-4">
            {emp.documents.map((d) => {
              const isPdf = (d.mimeType || "").includes("pdf");
              return (
                <div key={d.id}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-700">
                      {DOC_LABELS[d.type]}: {d.fileName}
                    </span>
                    <a
                      href={d.fileUrl}
                      download={d.fileName}
                      className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 transition hover:bg-slate-50"
                    >
                      הורדה
                    </a>
                  </div>
                  {isPdf ? (
                    <iframe
                      src={d.fileUrl}
                      title={d.fileName}
                      className="h-96 w-full rounded-lg border border-slate-200"
                    />
                  ) : (
                    <img
                      src={d.fileUrl}
                      alt={d.fileName}
                      className="max-h-96 w-full rounded-lg border border-slate-200 object-contain"
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
          <p className="text-sm text-slate-400">אין חתימות.</p>
        ) : (
          <div className="flex flex-wrap gap-6">
            {emp.signatures.map((s) => (
              <div key={s.id}>
                <p className="mb-1 text-xs text-slate-500">{SIG_LABELS[s.context]}</p>
                <img
                  src={s.imageData}
                  alt={SIG_LABELS[s.context]}
                  className="h-24 rounded-lg border border-slate-200 bg-white p-2"
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
