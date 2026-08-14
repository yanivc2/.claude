import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePdf, pdfPageCount } from '../src/lib/pdfPages.js';

// Minimal but structurally real PDFs — the shape every phone scanner app (Genius Scan, Adobe
// Scan, iOS "Scan Documents") produces: an uncompressed object structure with one /Type /Page
// object per page.
function pdfWithPages(n) {
  const kids = Array.from({ length: n }, (_, i) => `${i + 3} 0 R`).join(' ');
  const pages = Array.from(
    { length: n },
    (_, i) => `${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n`,
  ).join('');
  return Buffer.from(
    `%PDF-1.4\n` +
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n` +
      pages +
      `trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    'latin1',
  );
}

test('counts the page objects of a plain scanner PDF', () => {
  assert.equal(pdfPageCount(pdfWithPages(1)), 1);
  assert.equal(pdfPageCount(pdfWithPages(3)), 3);
  assert.equal(pdfPageCount(pdfWithPages(42)), 42);
});

test('/Pages (the tree node) is never mistaken for a page', () => {
  // The tree node appears once per file; if it leaked in, a 1-page PDF would report 2.
  assert.equal(pdfPageCount(pdfWithPages(1)), 1);
});

test('falls back to the page tree /Count when the page objects are compressed away', () => {
  const buf = Buffer.from(
    '%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Count 17 /Kids [] >>\nendobj\n' +
      '3 0 obj\n<< /Type /ObjStm /N 17 /Length 20 >>\nstream\n\x00\x01binary\nendstream\nendobj\n%%EOF',
    'latin1',
  );
  assert.equal(pdfPageCount(buf), 17);
});

test('reports null rather than guessing when nothing is readable', () => {
  assert.equal(pdfPageCount(Buffer.from('%PDF-1.7\nnothing useful here\n%%EOF', 'latin1')), null);
  assert.equal(pdfPageCount(Buffer.from('this is a JPEG, not a PDF')), null);
  assert.equal(pdfPageCount(Buffer.alloc(0)), null);
  assert.equal(pdfPageCount(null), null);
});

test('binary stream bytes cannot corrupt the scan', () => {
  // latin1 keeps every byte 1:1, so a JPEG embedded in the PDF is inert to the regexes.
  const jpegNoise = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const buf = Buffer.concat([pdfWithPages(2), Buffer.from('\n5 0 obj\nstream\n', 'latin1'), jpegNoise]);
  assert.equal(pdfPageCount(buf), 2);
});

test('looksLikePdf only accepts the %PDF- magic bytes', () => {
  assert.equal(looksLikePdf(pdfWithPages(1)), true);
  assert.equal(looksLikePdf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false);
  assert.equal(looksLikePdf(Buffer.alloc(0)), false);
  assert.equal(looksLikePdf(null), false);
});
