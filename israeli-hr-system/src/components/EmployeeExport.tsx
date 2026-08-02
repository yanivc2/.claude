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
        `<style>body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:0;line-height:1.5}` +
        `.page{margin:24px}h1{font-size:22px}h2{font-size:15px;margin-top:24px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}` +
        `table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}` +
        `td{border:1px solid #cbd5e1;padding:6px 10px;text-align:right}.meta{font-size:13px;color:#475569}` +
        `.bar{position:sticky;top:0;display:flex;flex-wrap:wrap;gap:16px;justify-content:center;background:#0f172a;padding:20px}` +
        `.bar button{border:0;border-radius:12px;padding:20px 48px;font-size:24px;font-weight:800;cursor:pointer}` +
        `.b-print{background:#4c51b8;color:#fff}.b-close{background:#ef4444;color:#fff}` +
        `@media print{.bar{display:none}.page{margin:0}}</style>` +
        `</head><body>` +
        `<div class="bar"><button class="b-print" onclick="window.print()">🖨️ הדפסה / שמירה</button>` +
        `<button class="b-close" onclick="window.close()">✕ סגירה</button></div>` +
        `<div class="page">` +
        `<h1>תיק עובד — ${escapeHtml(data.fullName)}</h1>` +
        `<p class="meta">הופק בתאריך ${date}</p>` +
        sectionsHtml +
        sigsHtml +
        docsHtml +
        `</div>` +
        `<script>window.onafterprint=function(){window.close()};` +
        `window.onload=function(){setTimeout(function(){window.print()},600)}<\/script>` +
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
