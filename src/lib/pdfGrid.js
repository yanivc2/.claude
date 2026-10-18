// PDF → string[][] for the "דוח פדיון" intake. The POS prints the same report as XLS and as PDF;
// a PDF has no cells, only positioned text, so the cells are rebuilt from the positions:
//   • a row  = text items on the same baseline (y within ROW_TOLERANCE points),
//   • a cell = one text item, ordered left→right by x.
// That reproduces the XLS grid exactly (label right-most, its figures to the left), so ONE parser
// (lib/revenueReportFile.js#parseSummaryGrid) reads both formats.
//
// pdfjs-dist is imported lazily — only a PDF upload pays for it. The worker module is imported
// explicitly and handed to pdfjs as `globalThis.pdfjsWorker`: pdfjs then runs it in-process
// instead of spawning a worker from a path it computes at runtime, which the Vercel bundle does not
// carry (a literal import() is what the file tracer follows). Text extraction needs no canvas; the
// optional @napi-rs/canvas is only for rendering pages, which we never do.

const ROW_TOLERANCE = 3;

/** True when the bytes are a PDF ('%PDF' at the start). */
export function looksLikePdf(buf) {
  return !!buf && buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '%PDF';
}

let loaded = null;
async function loadPdfjs() {
  if (!loaded) {
    loaded = (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      return pdfjs;
    })();
    loaded.catch(() => { loaded = null; }); // a failed load is retried on the next file
  }
  return loaded;
}

/**
 * Rows of text of every page, top to bottom, each row's cells left to right.
 * @param {Buffer} buf  PDF bytes
 * @returns {Promise<string[][]>}
 */
export async function pdfGrid(buf) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0, disableFontFace: true, useSystemFonts: false,
  }).promise;
  try {
    const grid = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      const rows = [];
      const cells = items
        .filter((it) => it && typeof it.str === 'string' && it.str.trim())
        .map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5] }))
        .sort((a, b) => b.y - a.y); // PDF y grows upward: top of the page first
      for (const c of cells) {
        let row = rows.find((r) => Math.abs(r.y - c.y) <= ROW_TOLERANCE);
        if (!row) { row = { y: c.y, cells: [] }; rows.push(row); }
        row.cells.push(c);
      }
      for (const r of rows) grid.push(r.cells.sort((a, b) => a.x - b.x).map((c) => c.s));
      page.cleanup();
    }
    return grid;
  } finally {
    await doc.destroy();
  }
}
