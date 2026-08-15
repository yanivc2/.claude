// Calibrate the capture screen's blur threshold — the number behind the red/green frame.
//
// SHARP_MIN in src/public/scan-capture.js decides whether a photographed page is called blurry.
// Picking that by feel is how you end up either crying wolf on every shot or waving through a
// page the model cannot read, so it is measured instead: run the REAL scoring function (copied
// from scan-capture.js and asserted identical by test/sharpness.test.js) over a real invoice
// photo at increasing blur, in the same engine that will run it on the phone, and read the curve.
//
//   node scripts/sharpness-calibrate.mjs <image> [more images...]
//
// Reading the output: text stops being reliably legible somewhere around a 2px blur at this
// working size. Put the threshold below the score at the last legible step and above the first
// illegible one, nearer the illegible end — a false "blurry" costs one retake, a false "sharp"
// costs a whole extraction.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BLURS = [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8];
const argv = process.argv.slice(2);
// --crop x,y,w,h isolates the document inside a screenshot; app chrome and a dark background are
// not what the phone will be scoring, and leaving them in skews the number the threshold sits on.
const cropArg = argv.find((a) => a.startsWith('--crop='));
const crop = cropArg ? cropArg.slice(7).split(',').map(Number) : null;
const files = argv.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node scripts/sharpness-calibrate.mjs <image> [image...]');
  process.exit(1);
}

// The scorer, verbatim from src/public/scan-capture.js. It runs inside the page.
const SCORER = `
function sharpnessOf(source, w, h, WORK) {
  var s = Math.min(1, WORK / Math.max(w, h));
  var cw = Math.max(8, Math.round(w * s));
  var ch = Math.max(8, Math.round(h * s));
  var c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  var ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, cw, ch);
  var data = ctx.getImageData(0, 0, cw, ch).data;

  var grey = new Float32Array(cw * ch);
  var sum = 0;
  for (var i = 0, p = 0; i < grey.length; i++, p += 4) {
    var g = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    grey[i] = g;
    sum += g;
  }
  var mean = sum / grey.length;
  var varSum = 0;
  for (var k = 0; k < grey.length; k++) {
    var d = grey[k] - mean;
    varSum += d * d;
  }
  var contrast = Math.sqrt(varSum / grey.length);
  if (contrast < 1) return 0;

  var lapSum = 0;
  var lapSq = 0;
  var n = 0;
  for (var y = 1; y < ch - 1; y++) {
    for (var x = 1; x < cw - 1; x++) {
      var idx = y * cw + x;
      var lap = 4 * grey[idx] - grey[idx - 1] - grey[idx + 1] - grey[idx - cw] - grey[idx + cw];
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  var lapMean = lapSum / n;
  return Math.sqrt(Math.max(0, lapSq / n - lapMean * lapMean)) / contrast;
}`;

// Use whatever Chromium the machine already has when the bundled revision is absent, rather than
// downloading 150MB to blur an image nine times.
const preinstalled = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', process.env.CHROME_PATH].filter(
  (p) => p && fs.existsSync(p),
);
const browser = await chromium.launch(preinstalled.length ? { executablePath: preinstalled[0] } : {});
const page = await browser.newPage();
await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
await page.addScriptTag({ content: SCORER });

console.log('score = σ(∇²I) / σ(I) on a 640px-long-edge greyscale copy\n');
for (const file of files) {
  const bytes = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).toLowerCase() || 'png';
  const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${bytes.toString('base64')}`;

  const row = await page.evaluate(
    async ({ dataUrl, blurs, crop }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const sx = crop ? crop[0] : 0;
      const sy = crop ? crop[1] : 0;
      const sw = crop ? crop[2] : img.naturalWidth;
      const sh = crop ? crop[3] : img.naturalHeight;
      const out = [];
      for (const b of blurs) {
        // Blur at NATIVE resolution, which is what a shaky hand or a missed focus actually does.
        const c = document.createElement('canvas');
        c.width = sw;
        c.height = sh;
        const ctx = c.getContext('2d');
        ctx.filter = b ? `blur(${b}px)` : 'none';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        // eslint-disable-next-line no-undef
        out.push({ blur: b, score: sharpnessOf(c, c.width, c.height, 640) });
      }
      return { w: sw, h: sh, out };
    },
    { dataUrl, blurs: BLURS, crop },
  );

  console.log(`${path.basename(file)}  ${row.w}×${row.h}`);
  console.log('  blur px | score  | vs sharp');
  const base = row.out[0].score || 1;
  for (const r of row.out) {
    console.log(
      `  ${String(r.blur).padStart(7)} | ${r.score.toFixed(3).padStart(6)} | ${(100 * (r.score / base)).toFixed(0).padStart(3)}%`,
    );
  }
  console.log('');
}

await browser.close();
