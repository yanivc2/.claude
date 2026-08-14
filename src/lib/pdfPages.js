// How many pages are in this PDF? — a dependency-free, best-effort reader.
//
// Why this exists: a PDF page costs the model its image tokens PLUS 1,500–3,000 text tokens for
// the extracted text layer, so a 300-page PDF dropped into the scan upload is by far the largest
// uncontrolled cost in the app. Multer caps each file's bytes and the file count, but a single
// small PDF can still carry hundreds of pages. This lets the scan service refuse it up front.
//
// It is deliberately a scanner, not a parser: pulling in a full PDF library to answer one integer
// is not worth it. Structure-plaintext PDFs — which is what phone scanner apps (Genius Scan,
// Adobe Scan, iOS "Scan Documents") produce — are read exactly. A PDF whose object structure sits
// inside compressed object streams (PDF 1.5+) may be unreadable here, and that is reported as
// `null` = "unknown", never as a wrong number. Callers must treat null as "let it through" — the
// byte-size cap is the backstop.

const PDF_MAGIC = '%PDF-';

/**
 * @param {Buffer|Uint8Array} buffer raw PDF bytes
 * @returns {number|null} page count, or null when it cannot be determined
 */
export function pdfPageCount(buffer) {
  if (!buffer || buffer.length === 0) return null;
  // latin1 keeps every byte 1:1, so binary streams can never corrupt the offsets we scan for.
  const text = Buffer.from(buffer).toString('latin1');
  if (!text.startsWith(PDF_MAGIC) && !text.slice(0, 1024).includes(PDF_MAGIC)) return null;

  // 1. Count the page objects themselves. `(?![s\w])` is what keeps /Pages (the tree node) out.
  const pageObjects = text.match(/\/Type\s*\/Page(?![s\w])/g);
  if (pageObjects && pageObjects.length > 0) return pageObjects.length;

  // 2. No plaintext page objects: fall back to the page tree's own /Count. Several may appear
  //    (one per tree node); the root holds the largest, which is the total.
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const maxCount = counts.length ? Math.max(...counts) : 0;
  if (maxCount > 0) return maxCount;

  // 3. Linearized ("fast web view") PDFs publish the total as /N in the first-page dictionary.
  const linearized = text.match(/\/Linearized[^>]*?\/N\s+(\d+)/);
  if (linearized) return Number(linearized[1]);

  return null;
}

/** True when the buffer looks like a PDF at all (cheap magic-byte check). */
export function looksLikePdf(buffer) {
  return Boolean(buffer && buffer.length >= 5 && Buffer.from(buffer.subarray(0, 5)).toString('latin1') === PDF_MAGIC);
}
