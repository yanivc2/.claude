"use client";

// ─────────────────────────────────────────────────────────────────────────
// כפתור ייצוא: פותח חלון הדפסה עם כל המידע של העובד — פרטים, פרטי העסקה,
// טופס 101, תיק פנסיה, המסמכים (ת.ז + הסכם) והחתימות. מתוך חלון ההדפסה של
// הדפדפן ניתן לבחור "שמירה כ-PDF".
// ─────────────────────────────────────────────────────────────────────────

export interface ExportDoc {
  title: string;
  fileName: string;
  mimeType: string;
  dataUrl: string;
}

export interface ExportData {
  fullName: string;
  sections: { title: string; rows: [string, string][] }[];
  documents: ExportDoc[];
  signatures: { label: string; dataUrl: string }[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function EmployeeExport({ data }: { data: ExportData }) {
  function exportAll() {
    const w = window.open("", "_blank");
    if (!w) {
      alert("החלון נחסם. אנא אפשר/י חלונות קופצים ונסה/י שוב.");
      return;
    }
    const date = new Date().toLocaleDateString("he-IL");

    const sectionsHtml = data.sections
      .map((sec) => {
        const rows = sec.rows
          .map(
            ([k, v]) =>
              `<tr><td style="font-weight:600;width:38%">${escapeHtml(k)}</td><td>${escapeHtml(
                v,
              )}</td></tr>`,
          )
          .join("");
        return `<h2>${escapeHtml(sec.title)}</h2><table>${rows}</table>`;
      })
      .join("");

    const docsHtml = data.documents.length
      ? data.documents
          .map((d) => {
            const isPdf = (d.mimeType || "").includes("pdf");
            const body = isPdf
              ? `<embed src="${d.dataUrl}" type="application/pdf" style="width:100%;height:80vh;border:1px solid #ddd" />`
              : `<img src="${d.dataUrl}" style="max-width:100%;border:1px solid #ddd" />`;
            return `<h2>${escapeHtml(d.title)} — ${escapeHtml(d.fileName)}</h2>${body}`;
          })
          .join("")
      : "";

    const sigsHtml = data.signatures.length
      ? `<h2>חתימות</h2>` +
        data.signatures
          .map(
            (s) =>
              `<div style="margin-bottom:12px"><p style="font-size:13px;color:#475569">${escapeHtml(
                s.label,
              )}</p><img src="${s.dataUrl}" style="height:100px" /></div>`,
          )
          .join("")
      : "";

    w.document.write(
      `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8" />` +
        `<title>תיק עובד — ${escapeHtml(data.fullName)}</title>` +
        `<style>body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:24px;line-height:1.5}` +
        `h1{font-size:22px}h2{font-size:15px;margin-top:24px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}` +
        `table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}` +
        `td{border:1px solid #cbd5e1;padding:6px 10px;text-align:right}.meta{font-size:13px;color:#475569}</style>` +
        `</head><body>` +
        `<h1>תיק עובד — ${escapeHtml(data.fullName)}</h1>` +
        `<p class="meta">הופק בתאריך ${date}</p>` +
        sectionsHtml +
        sigsHtml +
        docsHtml +
        `<script>window.onload=function(){setTimeout(function(){window.print()},500)}<\/script>` +
        `</body></html>`,
    );
    w.document.close();
  }

  return (
    <button
      type="button"
      onClick={exportAll}
      className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
    >
      ⬇️ הורדת כל תיק העובד (PDF)
    </button>
  );
}
