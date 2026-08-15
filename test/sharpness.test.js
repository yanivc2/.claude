import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The blur threshold behind the capture screen's red/green frame is calibrated by
// scripts/sharpness-calibrate.mjs, which runs the scorer in real Chromium over a real invoice
// photo. That calibration is only worth anything while the script scores images the same way the
// browser does — so the two copies of sharpnessOf() are compared here, character for character
// after whitespace. If this fails, the threshold in scan-capture.js was calibrated against a
// function that no longer exists.

const APP = fs.readFileSync(new URL('../src/public/scan-capture.js', import.meta.url), 'utf8');
const SCRIPT = fs.readFileSync(new URL('../scripts/sharpness-calibrate.mjs', import.meta.url), 'utf8');

/** The body of `function sharpnessOf(...)`, brace-matched so a nested `}` cannot end it early. */
function extractFn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Compare on logic only: comments and layout are free to differ between the two files. */
function normalize(fn) {
  return fn
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('the calibration script scores images exactly as the capture screen does', () => {
  const app = normalize(extractFn(APP, 'sharpnessOf'));
  // The script takes the working size as a parameter so a sweep can vary it; the app reads its
  // module constant. That single substitution is the only licensed difference.
  const script = normalize(extractFn(SCRIPT, 'sharpnessOf'))
    .replace('function sharpnessOf(source, w, h, WORK)', 'function sharpnessOf(source, w, h)')
    .replace('WORK / Math.max(w, h)', 'SHARP_WORK_EDGE / Math.max(w, h)');
  assert.equal(script, app);
});

test('the calibrated threshold and working size are the ones the sweep was run at', () => {
  // Hard-coded on purpose: changing either invalidates the measured table in the comment above
  // SHARP_MIN, and this is what makes that impossible to do silently.
  assert.match(APP, /var SHARP_WORK_EDGE = 640;/);
  assert.match(APP, /var SHARP_MIN = 0\.25;/);
  assert.match(SCRIPT, /sharpnessOf\(c, c\.width, c\.height, 640\)/);
});

test('the OpenCV scanner is gone, along with the CSP holes it needed', () => {
  // The 10MB vendored build, its viewfinder and its two CSP relaxations were removed together
  // when the owner measured a plain photo as the better input. Re-adding one without the others
  // is the failure this guards.
  // Comments stripped first: the file's header explains why the scanner was removed, and that
  // explanation is the point — it is the code that must be gone, not the word.
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  assert.doesNotMatch(code, /cv\.Mat|warpPerspective|getUserMedia|OPENCV_URL|opencv\.js/i);
  const appJs = fs
    .readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  assert.doesNotMatch(appJs, /wasm-unsafe-eval/);
  assert.doesNotMatch(appJs, /connect-src 'self' data:/);
  assert.equal(fs.existsSync(new URL('../public/vendor/opencv.js', import.meta.url)), false);
});

test('a page that cannot be scored still shows a verdict', () => {
  // The owner reported "no colour at all" after photographing. The cause was that renderPages
  // emitted no state when the score was unavailable, so a browser where the measurement failed
  // was indistinguishable from one where the feature was missing. All three states must render.
  assert.match(APP, /is-blurry/);
  assert.match(APP, /is-sharp/);
  assert.match(APP, /is-unknown/);
  assert.match(APP, /לא נבדק/);
  assert.match(APP, /scan-verdict/); // the pill, not only a border a phone can hide
  assert.match(APP, /sharpError/); // and the reason is carried, not swallowed
  const css = fs.readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  for (const cls of ['is-blurry', 'is-sharp', 'is-unknown']) {
    assert.ok(css.includes(`.scan-page.${cls} .scan-verdict`), `${cls} colours the pill`);
  }
});

test('the decode ladder keeps an untainted path before the blob: URL fallback', () => {
  // iOS Safari rejects createImageBitmap's options argument on several versions. Dropping
  // straight to <img>+blob: taints the canvas on WebKit, getImageData throws SecurityError, and
  // the verdict silently never appears — which is the bug the owner hit. The middle rung (an
  // ImageBitmap with NO options) never taints a canvas and must stay between them.
  const decode = APP.slice(APP.indexOf('var decode = function'), APP.indexOf('legacyDecode(file, finish, resolve);\n          });'));
  const withOptions = decode.indexOf('imageOrientation');
  const plain = decode.indexOf('createImageBitmap(file)');
  assert.ok(withOptions !== -1 && plain !== -1, 'both createImageBitmap calls are present');
  assert.ok(withOptions < plain, 'the oriented decode is tried first');
});
