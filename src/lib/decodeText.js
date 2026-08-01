// Decode a bank-export upload to a JS string, tolerating the encodings that
// Israeli banks and Hebrew Excel actually emit:
//   • UTF-8 (with or without a BOM)
//   • UTF-16 LE/BE (Excel "Unicode Text" saves)
//   • Windows-1255 (Hebrew ANSI — the historical default of Hebrew Windows/Excel)
//
// Reading a Windows-1255 file as UTF-8 turns every Hebrew header into mojibake,
// which is why a perfectly valid bank CSV would fail header detection and throw
// "שורה 2: חסר תאריך או סכום". Node 22 ships full ICU, so TextDecoder supports
// all of these natively — no external dependency needed.

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
export function decodeBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  // Byte-order marks are decisive when present.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  // No BOM: try strict UTF-8. Hebrew stored as Windows-1255 uses single high
  // bytes (0xE0–0xFA) that are not valid UTF-8 sequences, so a fatal decode
  // throws and we fall back to Windows-1255.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1255').decode(bytes);
    } catch {
      return bytes.toString('utf8'); // last resort — should be unreachable
    }
  }
}
