import { config } from '../config.js';

// Local OCR provider (stage 3). tesseract.js is an OPTIONAL, lazily-loaded dependency so the
// core app installs and runs without it. Install when ready:  npm install tesseract.js
// Runs fully on the PC — no financial document leaves the machine (§12).
//
// 🔴 Hebrew OCR accuracy on real invoices is limited; treat every result as a suggestion to be
// verified, never as authoritative. Language data (heb/eng traineddata) is fetched by
// tesseract.js; set OCR_LANG_PATH to a local folder for fully-offline operation.

/**
 * Recognize text in an image file using tesseract.js.
 * @param {string} imagePath  absolute path to an image (not PDF)
 * @returns {Promise<string>} raw recognized text
 */
export async function recognizeWithTesseract(imagePath) {
  let mod;
  try {
    mod = await import('tesseract.js');
  } catch {
    throw new Error('tesseract.js אינו מותקן. התקן לשלב 3:  npm install tesseract.js');
  }
  const tesseract = mod.default || mod;
  const options = config.ocr.langPath ? { langPath: config.ocr.langPath } : {};
  const { data } = await tesseract.recognize(imagePath, config.ocr.langs, options);
  return data?.text ?? '';
}
