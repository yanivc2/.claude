/* צילום חשבוניות — סורק אוטומטי בדפדפן.
 *
 * What this file is: the whole capture experience for /scan. A live camera viewfinder finds the
 * page edges frame by frame, waits until the frame is steady AND sharp, fires the shutter by
 * itself, then flattens the page with a perspective transform — the same idea as Genius Scan,
 * running entirely in the browser.
 *
 * Why it matters beyond convenience: the model is billed on pixel DIMENSIONS
 * (≈ ⌈w/28⌉ × ⌈h/28⌉ tokens), not on file size or colour. Cropping the counter/desk out of the
 * frame means every pixel we pay for is invoice, so we can send a SMALLER image that is MORE
 * readable. Colour is kept on purpose — greyscale costs exactly the same and throws information
 * away.
 *
 * Design rules this file sticks to:
 *  - OpenCV.js (~10MB) is loaded ONLY when the camera actually starts, never on page render.
 *  - Every failure degrades instead of blocking: no camera permission, no getUserMedia, or a
 *    failed OpenCV load all fall back to the plain `<input capture>` photo path.
 *  - Page order is positional, never completion order — see addFiles().
 *  - Imported photos are EXIF-corrected via createImageBitmap({imageOrientation:'from-image'});
 *    without it, a lot of Android photos reach the model sideways.
 *  - OpenCV.js has manual memory management. Every Mat allocated here is deleted.
 */
(function () {
  'use strict';

  // ---- tuning ------------------------------------------------------------------
  // These four are the behaviour of the auto-shutter. They were chosen conservatively: firing
  // late is a small annoyance, firing on a blurry frame costs a full extraction. Re-tune on a
  // real phone if the shutter feels sticky — and remember the manual button always works.
  var WORK_WIDTH = 480; // detection runs on a small copy; full res is only touched on capture
  var MIN_AREA_RATIO = 0.18; // the page must fill at least this much of the frame
  var STEADY_FRAMES = 4; // consecutive good frames before the shutter fires (~0.5s at 8fps)
  var MOVE_TOLERANCE = 0.025; // max corner drift between frames, as a fraction of the diagonal
  var SHARPNESS_MIN = 45; // variance of the Laplacian — the anti-blur gate
  var DETECT_INTERVAL_MS = 125; // ~8fps, so a mid-range phone keeps a smooth preview
  var RECAPTURE_PAUSE_MS = 1400; // ignore detections right after a shot (same page twice)
  var STUCK_EXPLAIN_MS = 2000; // how long a gate must block before the hint shows its numbers
  // Versioned on the OpenCV release, NOT on the app's build number: the service worker caches by
  // full URL, so tying this to a deploy would re-download 10MB on every deploy for nothing.
  var OPENCV_URL = '/vendor/opencv.js?v=4.9.0';
  var OPENCV_TIMEOUT_MS = 90000;

  var cfg = {
    maxPages: 8,
    maxEdge: 1800,
    jpegQuality: 0.9,
    maxUploadBytes: 10 * 1024 * 1024,
    maxTotalBytes: 18 * 1024 * 1024,
  };

  // ---- state -------------------------------------------------------------------
  var pages = []; // [{blob, url, isPdf, name}] — index IS the page number
  var el = {}; // cached DOM
  var stream = null;
  var track = null;
  var detectTimer = null;
  var cv = null; // the OpenCV module, once ready
  var cvPromise = null;
  var mats = null; // reusable Mats for the detection loop
  var lastQuad = null;
  var goodFrames = 0;
  var suppressUntil = 0;
  var autoOn = true;
  var busy = false; // a capture is being processed — do not start another
  var torchBound = false;
  var diagOn = false; // מצב אבחון — live gate numbers, for tuning the thresholds on a real phone
  var lastMetrics = null; // the gate values from the most recent frame
  var stuckReason = null; // which gate is currently holding the shutter
  var stuckSince = 0;

  // ---- small helpers -----------------------------------------------------------
  function $(id) {
    return document.getElementById(id);
  }
  function show(node, on) {
    if (node) node.style.display = on ? '' : 'none';
  }
  function setError(msg) {
    if (!el.err) return;
    el.err.textContent = msg || '';
    show(el.err, Boolean(msg));
  }
  function setHint(msg, tone) {
    if (!el.hint) return;
    el.hint.textContent = msg;
    el.hint.className = 'scan-live-hint' + (tone ? ' ' + tone : '');
  }
  function buzz(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) {
      /* vibration is a nicety, never a requirement */
    }
  }

  // ---- OpenCV loading ----------------------------------------------------------
  /**
   * Inject opencv.js on demand and resolve once its WASM runtime is live.
   * The module is seeded onto window.cv first: the UMD wrapper adopts an existing `cv` object as
   * its Module, which is the documented way to be handed `onRuntimeInitialized`.
   */
  function loadOpenCv() {
    if (cv) return Promise.resolve(cv);
    if (cvPromise) return cvPromise;
    cvPromise = new Promise(function (resolve, reject) {
      var settled = false;
      var finish = function () {
        if (settled) return;
        if (!window.cv || typeof window.cv.Mat !== 'function') return;
        settled = true;
        clearInterval(poll);
        clearTimeout(bail);
        cv = window.cv;
        resolve(cv);
      };
      window.cv = window.cv || {};
      window.cv.onRuntimeInitialized = finish;
      // Some builds are already initialised by the time onload fires, so poll as well.
      var poll = setInterval(finish, 120);
      var bail = setTimeout(function () {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        reject(new Error('opencv timeout'));
      }, OPENCV_TIMEOUT_MS);

      var s = document.createElement('script');
      s.src = OPENCV_URL;
      s.async = true;
      s.onload = finish;
      s.onerror = function () {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(bail);
        reject(new Error('opencv load failed'));
      };
      document.head.appendChild(s);
    });
    return cvPromise;
  }

  // ---- page list ---------------------------------------------------------------
  function totalBytes() {
    return pages.reduce(function (sum, p) {
      return sum + (p.blob ? p.blob.size : 0);
    }, 0);
  }

  function sync() {
    var storeChosen = Boolean(el.store && el.store.value);
    el.send.disabled = !(pages.length > 0 && storeChosen) || busy;
    el.count.textContent = pages.length
      ? 'נוספו ' + pages.length + ' עמודים' + (storeChosen ? '' : ' — יש לבחור חנות')
      : 'עדיין לא נוספו עמודים.';
    if (el.liveCount) el.liveCount.textContent = pages.length + '/' + cfg.maxPages;
  }

  function renderPages() {
    el.thumbs.innerHTML = '';
    pages.forEach(function (p, i) {
      var wrap = document.createElement('div');
      wrap.className = 'scan-page';
      wrap.innerHTML =
        '<div class="scan-thumb">' +
        (p.isPdf
          ? '<div class="scan-thumb-pdf">📄</div>'
          : '<img src="' + p.url + '" alt="עמוד ' + (i + 1) + '" />') +
        '<span class="scan-thumb-no">' + (i + 1) + '</span>' +
        '<button type="button" class="scan-thumb-x" data-act="del" aria-label="הסר עמוד ' + (i + 1) + '">✕</button>' +
        '<div class="scan-thumb-tools">' +
        '<button type="button" data-act="left" aria-label="הזז אחורה">›</button>' +
        (p.isPdf ? '' : '<button type="button" data-act="rot" aria-label="סובב 90 מעלות">↻</button>') +
        '<button type="button" data-act="right" aria-label="הזז קדימה">‹</button>' +
        '</div></div>' +
        // In diagnostics mode, each auto-shot carries the gate values that let it fire — so a bad
        // crop can be traced back to the numbers instead of re-shot blindly.
        (diagOn && p.metrics ? '<div class="scan-page-meta">' + metricsLabel(p.metrics) + '</div>' : '');
      wrap.addEventListener('click', function (ev) {
        var btn = ev.target.closest('button');
        if (!btn) return;
        ev.preventDefault();
        var act = btn.getAttribute('data-act');
        if (act === 'del') removePage(i);
        else if (act === 'rot') rotatePage(i);
        else if (act === 'left') movePage(i, -1);
        else if (act === 'right') movePage(i, 1);
      });
      el.thumbs.appendChild(wrap);
    });
    sync();
  }

  function removePage(i) {
    if (pages[i] && pages[i].url) URL.revokeObjectURL(pages[i].url);
    pages.splice(i, 1);
    renderPages();
  }

  function movePage(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= pages.length) return;
    var tmp = pages[i];
    pages[i] = pages[j];
    pages[j] = tmp;
    renderPages();
  }

  /** Rotate a captured page 90° clockwise — the manual complement to the automatic EXIF fix. */
  function rotatePage(i) {
    var p = pages[i];
    if (!p || p.isPdf) return;
    createImageBitmap(p.blob).then(function (bmp) {
      var c = document.createElement('canvas');
      c.width = bmp.height;
      c.height = bmp.width;
      var ctx = c.getContext('2d');
      ctx.translate(c.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      c.toBlob(function (blob) {
        if (!blob) return;
        URL.revokeObjectURL(p.url);
        pages[i] = { blob: blob, url: URL.createObjectURL(blob), isPdf: false, name: p.name, metrics: p.metrics };
        renderPages();
      }, 'image/jpeg', cfg.jpegQuality);
    });
  }

  function addPage(blob, isPdf, name, at, metrics) {
    var page = {
      blob: blob,
      isPdf: isPdf,
      url: isPdf ? null : URL.createObjectURL(blob),
      name: name,
      metrics: metrics || null,
    };
    if (typeof at === 'number') pages[at] = page;
    else pages.push(page);
    return page;
  }

  // ---- importing files (gallery / Genius Scan) ---------------------------------
  /**
   * Decode an image with its EXIF orientation applied and re-encode it at cfg.maxEdge.
   * The old implementation used `new Image()`, which ignores EXIF — that is why photos taken in
   * landscape arrived at the model rotated. createImageBitmap with imageOrientation:'from-image'
   * is the fix; the <img> path stays as a fallback for browsers without it.
   */
  function normalizeImage(file) {
    return new Promise(function (resolve) {
      // Resolves with null when the browser cannot decode the file at all (an iPhone HEIC picked
      // on Android is the realistic case). Uploading it would only fail server-side, later and
      // less clearly, so addFiles() drops it here with a message instead.
      var finish = function (source, w, h) {
        var s = Math.min(1, cfg.maxEdge / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * s);
        c.height = Math.round(h * s);
        c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
        if (source.close) source.close();
        c.toBlob(function (blob) {
          resolve(blob || file);
        }, 'image/jpeg', cfg.jpegQuality);
      };
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(file, { imageOrientation: 'from-image' })
          .then(function (bmp) {
            finish(bmp, bmp.width, bmp.height);
          })
          .catch(function () {
            legacyDecode(file, finish, resolve);
          });
        return;
      }
      legacyDecode(file, finish, resolve);
    });
  }

  function legacyDecode(file, finish, fail) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      finish(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      fail(null);
    };
    img.src = url;
  }

  /**
   * Add picked files. Slots are reserved BEFORE the async decoding starts, so pages land in the
   * order they were chosen — the previous version pushed inside the decode callback, which meant
   * a two-page invoice could reach the model back-to-front whenever page 2 decoded first.
   */
  function addFiles(list) {
    setError('');
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    var room = Math.max(0, cfg.maxPages - pages.length);
    if (files.length > room) {
      setError('אפשר לצרף עד ' + cfg.maxPages + ' עמודים לחשבונית.');
      files = files.slice(0, room);
    }
    if (!files.length) return;

    var base = pages.length;
    pages.length = base + files.length; // reserve the slots
    var pending = files.length;
    var rejected = 0;
    var settle = function () {
      pending -= 1;
      if (pending > 0) return;
      // Drop the slots nothing could be decoded into, keeping the rest in order.
      pages = pages.filter(Boolean);
      if (rejected) {
        setError(
          rejected +
            ' קבצים לא נתמכים ולא נוספו — קובץ HEIC של אייפון לא ייקרא כאן. צלמו דרך "פתח סורק" או שמרו כ-JPG.',
        );
      }
      renderPages();
    };
    files.forEach(function (f, i) {
      if (/pdf$/i.test(f.type)) {
        addPage(f, true, 'page.pdf', base + i);
        settle();
        return;
      }
      normalizeImage(f).then(function (blob) {
        if (blob) addPage(blob, false, 'page.jpg', base + i);
        else rejected += 1;
        settle();
      });
    });
  }

  // ---- geometry ----------------------------------------------------------------
  /** Order 4 points as [top-left, top-right, bottom-right, bottom-left]. */
  function orderCorners(pts) {
    var bySum = pts.slice().sort(function (a, b) { return a.x + a.y - (b.x + b.y); });
    var byDiff = pts.slice().sort(function (a, b) { return a.y - a.x - (b.y - b.x); });
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Largest corner movement between two quads, as a fraction of the frame diagonal. */
  function drift(a, b, diagonal) {
    if (!a || !b) return Infinity;
    var worst = 0;
    for (var i = 0; i < 4; i++) worst = Math.max(worst, dist(a[i], b[i]));
    return worst / diagonal;
  }

  // ---- detection ---------------------------------------------------------------
  function ensureMats() {
    if (mats) return mats;
    mats = {
      gray: new cv.Mat(),
      edges: new cv.Mat(),
      lap: new cv.Mat(),
      mean: new cv.Mat(),
      stddev: new cv.Mat(),
      kernel: cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)),
    };
    return mats;
  }

  function freeMats() {
    if (!mats) return;
    Object.keys(mats).forEach(function (k) {
      try {
        mats[k].delete();
      } catch (e) {
        /* already gone */
      }
    });
    mats = null;
  }

  /**
   * Find the page in one working-size frame.
   * @returns {{quad: Array<{x,y}>|null, sharpness: number}}
   */
  function analyse(src) {
    var m = ensureMats();
    cv.cvtColor(src, m.gray, cv.COLOR_RGBA2GRAY);

    // Sharpness first — it is cheap and it is the gate that keeps blurry pages out.
    cv.Laplacian(m.gray, m.lap, cv.CV_64F);
    cv.meanStdDev(m.lap, m.mean, m.stddev);
    var sd = m.stddev.doubleAt(0, 0);
    var sharpness = sd * sd;

    cv.GaussianBlur(m.gray, m.gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(m.gray, m.edges, 60, 160);
    // Close small gaps so an edge broken by a ceiling-light glare still forms a closed contour.
    cv.morphologyEx(m.edges, m.edges, cv.MORPH_CLOSE, m.kernel);

    var contours = new cv.MatVector();
    var hierarchy = new cv.Mat();
    cv.findContours(m.edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    // Keep the largest convex quad even when it is too small to accept: it is the difference
    // between "I see nothing" and "get closer, you are at 12% of 18%", which is the single most
    // useful thing the hint line can say.
    var frameArea = src.cols * src.rows;
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < contours.size(); i++) {
      var c = contours.get(i);
      var approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        var area = Math.abs(cv.contourArea(approx));
        if (area > bestArea) {
          bestArea = area;
          best = [];
          for (var j = 0; j < 4; j++) best.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
        }
      }
      approx.delete();
      c.delete();
    }
    contours.delete();
    hierarchy.delete();

    var areaRatio = frameArea > 0 ? bestArea / frameArea : 0;
    return {
      quad: best && areaRatio >= MIN_AREA_RATIO ? orderCorners(best) : null,
      areaRatio: best ? areaRatio : 0,
      sharpness: sharpness,
    };
  }

  function drawOverlay(quad, ratio, scale) {
    var ctx = el.overlay.getContext('2d');
    ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    if (!quad) return;
    var ready = ratio >= 1;
    var stroke = ready ? '#2ecc71' : ratio > 0 ? '#f0b429' : '#e05561';
    ctx.beginPath();
    quad.forEach(function (p, i) {
      var x = p.x * scale;
      var y = p.y * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.fillStyle = ready ? 'rgba(46,204,113,.22)' : 'rgba(46,204,113,' + (0.16 * ratio).toFixed(3) + ')';
    ctx.fill();
    quad.forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, 5, 0, Math.PI * 2);
      ctx.fillStyle = stroke;
      ctx.fill();
    });
  }

  function detectTick() {
    if (!cv || !stream || busy || el.video.readyState < 2) return;
    var vw = el.video.videoWidth;
    var vh = el.video.videoHeight;
    if (!vw || !vh) return;

    var work = el.work;
    var scale = WORK_WIDTH / vw;
    work.width = WORK_WIDTH;
    work.height = Math.round(vh * scale);
    work.getContext('2d').drawImage(el.video, 0, 0, work.width, work.height);

    var src = cv.imread(work);
    var result;
    try {
      result = analyse(src);
    } finally {
      src.delete();
    }

    // Keep the overlay the same size as the video is actually displayed at.
    var rect = el.video.getBoundingClientRect();
    if (el.overlay.width !== Math.round(rect.width) || el.overlay.height !== Math.round(rect.height)) {
      el.overlay.width = Math.round(rect.width);
      el.overlay.height = Math.round(rect.height);
    }
    var overlayScale = el.overlay.width / work.width;

    var quad = result.quad;
    var diagonal = Math.hypot(work.width, work.height);
    var driftRatio = quad ? drift(quad, lastQuad, diagonal) : Infinity;
    var steady = driftRatio < MOVE_TOLERANCE;
    var sharp = result.sharpness >= SHARPNESS_MIN;

    if (quad && steady && sharp) goodFrames += 1;
    else goodFrames = 0;
    lastQuad = quad;

    // Everything the auto-shutter decided on, kept for the diagnostics readout and stamped onto
    // the page when the shutter actually fires. Instrumentation only — nothing here feeds back
    // into the detection maths.
    lastMetrics = {
      area: result.areaRatio,
      sharpness: result.sharpness,
      drift: driftRatio,
      steady: goodFrames,
    };

    drawOverlay(quad, goodFrames / STEADY_FRAMES, overlayScale);
    reportGates(quad, result, driftRatio, sharp, steady);

    if (autoOn && goodFrames >= STEADY_FRAMES && Date.now() > suppressUntil) capture(quad, work.width);
  }

  var pct = function (v) {
    return Math.round(v * 100) + '%';
  };

  /**
   * Say which gate is holding the shutter — and, once a state has persisted, say it with the
   * numbers. A transient "almost" stays clean; a genuinely stuck frame explains itself, which is
   * what turns "it doesn't shoot" into something tunable.
   */
  function reportGates(quad, result, driftRatio, sharp, steady) {
    var reason = !quad
      ? result.areaRatio > 0.02
        ? 'small'
        : 'none'
      : !sharp
        ? 'blur'
        : !steady
          ? 'move'
          : 'ok';
    if (reason !== stuckReason) {
      stuckReason = reason;
      stuckSince = Date.now();
    }
    var verbose = reason !== 'ok' && Date.now() - stuckSince > STUCK_EXPLAIN_MS;

    if (reason === 'none') setHint('כוונו את המצלמה כך שכל החשבונית תיראה במסך', 'bad');
    else if (reason === 'small')
      setHint(
        verbose
          ? 'התקרבו — המסמך תופס ' + pct(result.areaRatio) + ' מהמסך, נדרש ' + pct(MIN_AREA_RATIO)
          : 'התקרבו — המסמך קטן מדי בפריים',
        'bad',
      );
    else if (reason === 'blur')
      setHint(
        verbose
          ? 'מטושטש — חדות ' + Math.round(result.sharpness) + ' מתוך ' + SHARPNESS_MIN + ' נדרש'
          : 'התמונה מטושטשת — החזיקו יציב ותנו למצלמה להתמקד',
        'warn',
      );
    else if (reason === 'move')
      setHint(
        verbose && isFinite(driftRatio)
          ? 'תזוזה ' + pct(driftRatio) + ' — מותר עד ' + pct(MOVE_TOLERANCE)
          : 'כמעט — החזיקו את הטלפון יציב',
        'warn',
      );
    else setHint('מצוין — מצלם…', 'ok');

    renderDiag();
  }

  // ---- diagnostics readout (מצב אבחון) -----------------------------------------
  /** One row: label, measured value, the threshold it is judged against, pass/fail. */
  function diagRow(label, value, limit, ok) {
    return (
      '<span class="' + (ok ? 'ok' : 'bad') + '">' + label + ' <b>' + value + '</b> / ' + limit + '</span>'
    );
  }

  function renderDiag() {
    if (!diagOn || !el.diag || !lastMetrics) return;
    var m = lastMetrics;
    el.diag.innerHTML =
      diagRow('שטח', pct(m.area), pct(MIN_AREA_RATIO), m.area >= MIN_AREA_RATIO) +
      diagRow('חדות', Math.round(m.sharpness), SHARPNESS_MIN, m.sharpness >= SHARPNESS_MIN) +
      diagRow('תזוזה', isFinite(m.drift) ? pct(m.drift) : '—', pct(MOVE_TOLERANCE), m.drift < MOVE_TOLERANCE) +
      diagRow('פריימים', m.steady, STEADY_FRAMES, m.steady >= STEADY_FRAMES);
  }

  function setDiag(on) {
    diagOn = on;
    show(el.diag, on);
    if (!on && el.diag) el.diag.innerHTML = '';
    try {
      localStorage.setItem('scanDiag', on ? '1' : '');
    } catch (e) {
      /* private mode — the toggle just doesn't persist */
    }
    renderPages(); // the per-page metric line appears/disappears with the mode
  }

  /** Human-readable summary of the frame that actually fired — shown under its thumbnail. */
  function metricsLabel(m) {
    if (!m) return '';
    return 'שטח ' + pct(m.area) + ' · חדות ' + Math.round(m.sharpness) + ' · תזוזה ' + (isFinite(m.drift) ? pct(m.drift) : '—');
  }

  // ---- capture -----------------------------------------------------------------
  /**
   * Grab the current frame at full sensor resolution and flatten the detected page onto it.
   * @param {Array<{x,y}>|null} quad in working-frame coordinates, or null for an uncropped shot
   * @param {number} workWidth the width those coordinates are relative to
   */
  function capture(quad, workWidth) {
    if (busy) return;
    if (pages.length >= cfg.maxPages) {
      setHint('הגעתם ל-' + cfg.maxPages + ' עמודים — שלחו לעיבוד', 'warn');
      return;
    }
    busy = true;
    suppressUntil = Date.now() + RECAPTURE_PAUSE_MS;
    goodFrames = 0;
    stuckReason = null;
    var firedWith = lastMetrics; // the gate values of this exact frame, kept with the page
    buzz(35);
    flash();

    var full = el.full;
    full.width = el.video.videoWidth;
    full.height = el.video.videoHeight;
    full.getContext('2d').drawImage(el.video, 0, 0, full.width, full.height);

    var out = document.createElement('canvas');
    var ok = quad && cv ? warpTo(out, full, quad, full.width / workWidth) : false;
    if (!ok) {
      // No usable quad (or no OpenCV): keep the frame as-is, just size-capped.
      var s = Math.min(1, cfg.maxEdge / Math.max(full.width, full.height));
      out.width = Math.round(full.width * s);
      out.height = Math.round(full.height * s);
      out.getContext('2d').drawImage(full, 0, 0, out.width, out.height);
    }

    out.toBlob(
      function (blob) {
        busy = false;
        if (!blob) {
          setError('לא הצלחנו לשמור את הצילום — נסו שוב');
          return;
        }
        addPage(blob, false, 'page.jpg', undefined, firedWith);
        renderPages();
        setHint('עמוד ' + pages.length + ' נוסף ✓', 'ok');
      },
      'image/jpeg',
      cfg.jpegQuality,
    );
  }

  /**
   * Perspective-correct `source` onto `target` using the detected quad.
   * The output size comes from the quad's own edge lengths (so the aspect ratio of the real page
   * is preserved) and is capped at cfg.maxEdge in the SAME step — warping straight to the final
   * size resamples once instead of twice.
   */
  function warpTo(target, source, quad, upscale) {
    var pts = quad.map(function (p) {
      return { x: p.x * upscale, y: p.y * upscale };
    });
    var w = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]));
    var h = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]));
    if (!(w > 40 && h > 40)) return false;
    var s = Math.min(1, cfg.maxEdge / Math.max(w, h));
    w = Math.round(w * s);
    h = Math.round(h * s);

    var src = cv.imread(source);
    var dst = new cv.Mat();
    var from = cv.matFromArray(4, 1, cv.CV_32FC2, [
      pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y,
    ]);
    var to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    var M = cv.getPerspectiveTransform(from, to);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
      target.width = w;
      target.height = h;
      cv.imshow(target, dst);
      return true;
    } finally {
      src.delete();
      dst.delete();
      from.delete();
      to.delete();
      M.delete();
    }
  }

  function flash() {
    if (!el.flash) return;
    el.flash.classList.remove('on');
    void el.flash.offsetWidth; // restart the animation
    el.flash.classList.add('on');
  }

  // ---- camera ------------------------------------------------------------------
  function cameraSupported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);
  }

  function startCamera() {
    setError('');
    if (stream) return; // already open — a second tap must not grab a second camera track
    if (!cameraSupported()) {
      fallbackToNativeCamera('הדפדפן לא מאפשר תצוגת מצלמה חיה — נשתמש במצלמת המכשיר.');
      return;
    }
    show(el.live, true);
    setHint('פותח מצלמה…', '');
    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      })
      .then(function (s) {
        stream = s;
        track = s.getVideoTracks()[0] || null;
        el.video.srcObject = s;
        applyCameraCapabilities();
        return el.video.play();
      })
      .then(function () {
        setHint('טוען זיהוי קצוות…', '');
        return loadOpenCv();
      })
      .then(function () {
        detectTimer = setInterval(detectTick, DETECT_INTERVAL_MS);
        setHint('כוונו את המצלמה כך שכל החשבונית תיראה במסך', 'bad');
      })
      .catch(function (err) {
        var name = err && err.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          stopCamera();
          fallbackToNativeCamera('אין הרשאת מצלמה לדפדפן — נשתמש במצלמת המכשיר.');
          return;
        }
        if (stream) {
          // The camera works, only the edge detection failed: keep the manual shutter.
          autoOn = false;
          if (el.autoToggle) el.autoToggle.disabled = true;
          setHint('זיהוי הקצוות לא נטען — צלמו ידנית בכפתור', 'warn');
          return;
        }
        stopCamera();
        fallbackToNativeCamera('לא הצלחנו לפתוח את המצלמה — נשתמש במצלמת המכשיר.');
      });
  }

  /**
   * Continuous autofocus and the torch are Chrome-on-Android only; iOS Safari exposes neither.
   * Everything here is capability-guarded, so an unsupported browser simply gets nothing extra —
   * the sharpness gate in analyse() is what protects image quality on those devices.
   */
  function applyCameraCapabilities() {
    if (!track || !track.getCapabilities) return;
    var caps = {};
    try {
      caps = track.getCapabilities() || {};
    } catch (e) {
      return;
    }
    if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
    }
    if (caps.torch) {
      show(el.torch, true);
      if (!torchBound) {
        torchBound = true; // startCamera may run again — bind the handler exactly once
        el.torch.addEventListener('click', function () {
          if (!track) return;
          var on = el.torch.getAttribute('aria-pressed') === 'true';
          track
            .applyConstraints({ advanced: [{ torch: !on }] })
            .then(function () {
              el.torch.setAttribute('aria-pressed', String(!on));
            })
            .catch(function () {});
        });
      }
    }
  }

  function stopCamera() {
    if (detectTimer) {
      clearInterval(detectTimer);
      detectTimer = null;
    }
    if (stream) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
      stream = null;
      track = null;
    }
    el.video.srcObject = null;
    lastQuad = null;
    goodFrames = 0;
    freeMats();
    show(el.live, false);
    show(el.torch, false);
  }

  /** Hide the live scanner and expose the plain OS-camera button instead. */
  function fallbackToNativeCamera(reason) {
    show(el.live, false);
    show(el.fallback, true);
    if (el.fallbackNote) el.fallbackNote.textContent = reason;
  }

  // ---- upload ------------------------------------------------------------------
  function upload() {
    if (!pages.length || !el.store.value) return;
    setError('');
    // Checked here rather than after the upload: the server refuses the batch at 20MB, and
    // discovering that only after a slow mobile upload wastes the employee's time.
    if (totalBytes() > cfg.maxTotalBytes) {
      setError('הצילומים כבדים מדי יחד — הסירו עמוד או צלמו שוב.');
      return;
    }
    var oversized = pages.findIndex(function (p) {
      return p.blob.size > cfg.maxUploadBytes;
    });
    if (oversized !== -1) {
      setError('עמוד ' + (oversized + 1) + ' גדול מדי — הסירו אותו וצלמו שוב.');
      return;
    }

    busy = true;
    sync();
    var label = el.send.textContent;
    el.send.textContent = 'מעלה…';
    show(el.progressWrap, true);
    setProgress(0);

    var fd = new FormData();
    fd.append('store_id', el.store.value);
    pages.forEach(function (p, i) {
      fd.append('images', p.blob, 'page-' + (i + 1) + (p.isPdf ? '.pdf' : '.jpg'));
    });

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/scan/upload');
    xhr.upload.onprogress = function (ev) {
      if (ev.lengthComputable) setProgress(ev.loaded / ev.total);
    };
    xhr.onload = function () {
      var body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch (e) {
        /* keep body empty — handled below */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.id) {
        setProgress(1);
        stopCamera();
        location.href = '/scan/' + body.id;
        return;
      }
      failUpload(body.error || 'ההעלאה נכשלה — נסו שוב', label);
    };
    xhr.onerror = function () {
      failUpload('ההעלאה נכשלה — בדקו את החיבור ונסו שוב', label);
    };
    xhr.send(fd);
  }

  function failUpload(msg, label) {
    busy = false;
    setError(msg);
    el.send.textContent = label;
    show(el.progressWrap, false);
    sync();
  }

  function setProgress(ratio) {
    if (el.progressBar) el.progressBar.style.width = Math.round(ratio * 100) + '%';
  }

  // ---- init --------------------------------------------------------------------
  function init() {
    var configNode = $('scanConfig');
    if (configNode) {
      try {
        var parsed = JSON.parse(configNode.textContent);
        Object.keys(parsed).forEach(function (k) {
          cfg[k] = parsed[k];
        });
      } catch (e) {
        /* defaults above are already sane */
      }
    }

    el = {
      store: $('scanStore'),
      thumbs: $('scanThumbs'),
      count: $('scanCount'),
      err: $('scanErr'),
      send: $('btnSend'),
      live: $('scanLive'),
      video: $('scanVideo'),
      overlay: $('scanOverlay'),
      // Off-screen scratch canvases: `work` is the small copy the detector runs on, `full` is the
      // full-resolution frame grab. They never enter the document.
      work: document.createElement('canvas'),
      full: document.createElement('canvas'),
      hint: $('scanLiveHint'),
      diag: $('scanDiag'),
      diagToggle: $('chkDiag'),
      liveCount: $('scanLiveCount'),
      flash: $('scanFlash'),
      torch: $('btnTorch'),
      autoToggle: $('chkAuto'),
      fallback: $('scanFallback'),
      fallbackNote: $('scanFallbackNote'),
      progressWrap: $('scanProgress'),
      progressBar: $('scanProgressBar'),
      camInput: $('camInput'),
      fileInput: $('fileInput'),
    };
    if (!el.store || !el.send) return; // the AI-disabled version of the page

    try {
      var last = localStorage.getItem('scanStoreId');
      if (last) el.store.value = last;
    } catch (e) {
      /* private mode — the picker just starts empty */
    }
    el.store.addEventListener('change', function () {
      try {
        localStorage.setItem('scanStoreId', el.store.value);
      } catch (e) {
        /* ignore */
      }
      sync();
    });

    $('btnStart').addEventListener('click', startCamera);
    $('btnStop').addEventListener('click', stopCamera);
    $('btnShutter').addEventListener('click', function () {
      capture(lastQuad, el.work.width);
    });
    if (el.autoToggle) {
      autoOn = el.autoToggle.checked;
      el.autoToggle.addEventListener('change', function () {
        autoOn = el.autoToggle.checked;
      });
    }
    if (el.diagToggle) {
      var savedDiag = false;
      try {
        savedDiag = localStorage.getItem('scanDiag') === '1';
      } catch (e) {
        /* private mode — starts off */
      }
      el.diagToggle.checked = savedDiag;
      setDiag(savedDiag);
      el.diagToggle.addEventListener('change', function () {
        setDiag(el.diagToggle.checked);
      });
    }
    $('btnFiles').addEventListener('click', function () {
      el.fileInput.click();
    });
    $('btnNativeCam').addEventListener('click', function () {
      el.camInput.click();
    });
    el.camInput.addEventListener('change', function () {
      addFiles(el.camInput.files);
      el.camInput.value = '';
    });
    el.fileInput.addEventListener('change', function () {
      addFiles(el.fileInput.files);
      el.fileInput.value = '';
    });
    el.send.addEventListener('click', upload);

    if (!cameraSupported()) fallbackToNativeCamera('הדפדפן לא תומך בתצוגת מצלמה חיה — צלמו במצלמת המכשיר.');

    // Never hold the camera open in a backgrounded tab.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && stream) stopCamera();
    });
    window.addEventListener('pagehide', stopCamera);

    sync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
