/* צילום חשבוניות — מצלמת המכשיר + בדיקת חדות.
 *
 * What this file is: the whole capture experience for /scan. Photos are taken with the phone's
 * OWN camera app (`<input capture="environment">`), and every page that comes back is scored for
 * sharpness here — a red frame and "צלם שוב" on a blurry page, a green frame on a good one.
 *
 * Why it no longer scans. This used to be a Genius-Scan-style pipeline: a live viewfinder,
 * OpenCV.js edge detection, an auto-shutter, and a perspective warp that flattened the page. It
 * was ~900 lines and a 10MB WASM download, and the owner measured the result against an ordinary
 * photo: **the ordinary photo won.** That is not surprising in hindsight — the OS camera app has
 * autofocus, HDR and multi-frame denoise that a getUserMedia frame grab simply does not, and the
 * crop was throwing away that advantage to save pixels we were not short of. So the pipeline is
 * gone, along with the CSP relaxations it required.
 *
 * What is kept, because it is what actually protects the extraction:
 *  - **The sharpness gate.** Blur is the one defect that silently ruins an extraction; a skewed
 *    but sharp page reads fine. The score is the variance of the Laplacian over a fixed-size
 *    greyscale copy, divided by that copy's own contrast — a ratio, so it does not move with
 *    lighting or with how much white space the page has. The threshold is calibrated, not
 *    guessed: see scripts/sharpness-calibrate.mjs and docs/צילום-וחילוץ/טכנולוגיה/סורק-מצלמה.md.
 *  - **A warning, never a block.** A soft warning beats refusing the only photo of an invoice the
 *    employee is standing in front of.
 *  - Page order is positional, never completion order — see addFiles().
 *  - Imported photos are EXIF-corrected via createImageBitmap({imageOrientation:'from-image'});
 *    without it a lot of Android photos reach the model sideways, and the API reads no metadata.
 */
(function () {
  'use strict';

  // ---- tuning ------------------------------------------------------------------
  /** Long edge of the greyscale copy the score is computed on. Fixing it is what makes one
   *  threshold work across a 12MP phone and a 3MP one. */
  var SHARP_WORK_EDGE = 640;
  /**
   * Below this a page is called blurry. Calibrated on the owner's own invoice photo with
   * scripts/sharpness-calibrate.mjs (blur sweep, real Chromium, this exact scorer):
   *
   *     blur   score   legible?
   *     none   0.667   yes  ← a real, in-focus invoice photo
   *     1px    0.324   just
   *     1.5px  0.232   no
   *     2px    0.124   no
   *
   * 0.25 sits between "just legible" and "no", deliberately nearer the illegible end rather than
   * in the middle. The costs are not symmetric and the history here is specific: the previous
   * capture screen refused to take the shot until it was satisfied, and that is exactly why the
   * owner asked for it to be removed. Crying wolf on a usable photo is the expensive mistake; a
   * page has to be visibly bad to be flagged, and even then it can still be sent.
   */
  var SHARP_MIN = 0.25;

  var cfg = {
    maxPages: 8,
    maxEdge: 2500,
    // The model's real limit is an AREA limit: it bills ⌈w/28⌉×⌈h/28⌉ tokens and caps at 4,784,
    // so a long-edge rule alone either wastes resolution on a portrait page or overshoots on a
    // landscape one. 3.5MP leaves room for the ceilings to round up and still land under the cap
    // (1600×2260 → 58×81 = 4,698). Going over does not cost more — it makes the API resample the
    // image server-side, which is an extra resample we neither control nor see.
    maxPixels: 3500000,
    // 4:2:0 chroma subsampling (what Chrome emits below quality 1.0) halves the resolution of
    // COLOUR only; luminance stays full-res, and text is a luminance signal.
    jpegQuality: 0.92,
    maxUploadBytes: 10 * 1024 * 1024,
    maxTotalBytes: 18 * 1024 * 1024,
  };

  // ---- state -------------------------------------------------------------------
  var pages = []; // [{blob, url, isPdf, name, sharp}] — index IS the page number
  var el = {}; // cached DOM
  var busy = false; // an upload is in flight — do not start another

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

  // ---- sharpness ---------------------------------------------------------------
  /**
   * Score how sharp an image is: |∇²I| energy relative to the image's own contrast.
   *
   * Raw Laplacian variance is the textbook blur metric and it is not usable on its own here — it
   * rises with contrast and with how much print is on the page, so a dense invoice in good light
   * and a sparse one in dim light score wildly differently at the same focus. Dividing by the
   * grey standard deviation cancels both, leaving a number that tracks focus alone.
   *
   * @param {ImageBitmap|HTMLImageElement} source decoded image
   * @param {number} w
   * @param {number} h
   * @returns {number} 0 = flat, higher = sharper
   */
  function sharpnessOf(source, w, h) {
    var s = Math.min(1, SHARP_WORK_EDGE / Math.max(w, h));
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
    if (contrast < 1) return 0; // a blank frame: no signal to judge focus by

    // 4-neighbour Laplacian over the interior. Its own standard deviation is the edge energy.
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
  }

  /** Score a stored page blob. Resolves with null when the blob cannot be decoded. */
  function scorePage(blob) {
    return new Promise(function (resolve) {
      if (typeof createImageBitmap !== 'function') return resolve(null);
      createImageBitmap(blob)
        .then(function (bmp) {
          var score;
          try {
            score = sharpnessOf(bmp, bmp.width, bmp.height);
          } catch (e) {
            score = null; // a tainted or oversized canvas is not worth failing the capture over
          }
          if (bmp.close) bmp.close();
          resolve(score);
        })
        .catch(function () {
          resolve(null);
        });
    });
  }

  // ---- pages -------------------------------------------------------------------
  function totalBytes() {
    return pages.reduce(function (sum, p) {
      return sum + (p.blob ? p.blob.size : 0);
    }, 0);
  }

  function blurryCount() {
    return pages.filter(function (p) {
      return p.sharp !== null && p.sharp !== undefined && p.sharp < SHARP_MIN;
    }).length;
  }

  function sync() {
    var storeChosen = Boolean(el.store && el.store.value);
    el.send.disabled = !(pages.length > 0 && storeChosen) || busy;
    var blurry = blurryCount();
    el.count.textContent = pages.length
      ? 'נוספו ' + pages.length + ' עמודים' +
        (storeChosen ? '' : ' — יש לבחור חנות') +
        (blurry ? ' · ' + blurry + ' מטושטשים' : '')
      : 'עדיין לא נוספו עמודים.';
    // Say it once, above the strip, so it is not only a colour — a red border alone is invisible
    // to anyone who does not know it means something.
    if (el.warn) {
      el.warn.textContent = blurry
        ? blurry === 1
          ? 'עמוד אחד יצא מטושטש. אפשר לשלוח בכל זאת, אבל צילום חד יקרא הרבה יותר טוב — לחצו “צלם שוב” על העמוד האדום.'
          : blurry + ' עמודים יצאו מטושטשים. אפשר לשלוח בכל זאת, אבל צילום חד יקרא הרבה יותר טוב.'
        : '';
      show(el.warn, Boolean(blurry));
    }
  }

  function renderPages() {
    el.thumbs.innerHTML = '';
    pages.forEach(function (p, i) {
      var blurry = p.sharp !== null && p.sharp !== undefined && p.sharp < SHARP_MIN;
      var state = p.isPdf || p.sharp === null || p.sharp === undefined ? '' : blurry ? ' is-blurry' : ' is-sharp';
      var wrap = document.createElement('div');
      wrap.className = 'scan-page' + state;
      wrap.innerHTML =
        '<div class="scan-thumb"' + (p.isPdf ? '' : ' data-act="open" role="button" tabindex="0"') + '>' +
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
        (p.isPdf
          ? ''
          : '<div class="scan-page-state">' +
            (blurry
              ? '<span class="bad">מטושטש</span><button type="button" class="scan-reshoot" data-act="reshoot">צלם שוב</button>'
              : p.sharp === null || p.sharp === undefined
                ? '<span>נוסף</span>'
                : '<span class="ok">חד ✓</span>') +
            '</div>');
      wrap.addEventListener('click', function (ev) {
        var hit = ev.target.closest('[data-act]');
        if (!hit) return;
        ev.preventDefault();
        var act = hit.getAttribute('data-act');
        if (act === 'del') removePage(i);
        else if (act === 'rot') rotatePage(i);
        else if (act === 'left') movePage(i, -1);
        else if (act === 'right') movePage(i, 1);
        else if (act === 'open') openPage(i);
        else if (act === 'reshoot') reshoot(i);
      });
      el.thumbs.appendChild(wrap);
    });
    sync();
  }

  /**
   * Show a captured page full-size. Without this the only view of a photo is a 104px thumbnail,
   * so "did that come out readable?" could not be answered before sending it — which is exactly
   * the question the sharpness score raises.
   */
  function openPage(i) {
    var p = pages[i];
    if (!p || p.isPdf || !el.viewDlg) return;
    el.viewImg.src = p.url;
    el.viewCap.textContent =
      'עמוד ' + (i + 1) + ' מתוך ' + pages.length +
      (p.sharp === null || p.sharp === undefined
        ? ''
        : p.sharp < SHARP_MIN
          ? ' · מטושטש — מומלץ לצלם שוב'
          : ' · חד ✓');
    if (el.viewDlg.showModal) el.viewDlg.showModal();
  }

  /** Drop this page and reopen the camera on the spot, so a bad shot is one tap from fixed. */
  function reshoot(i) {
    removePage(i);
    el.camInput.click();
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
        // Rotation does not change focus, so the score carries over rather than being recomputed.
        pages[i] = { blob: blob, url: URL.createObjectURL(blob), isPdf: false, name: p.name, sharp: p.sharp };
        renderPages();
      }, 'image/jpeg', cfg.jpegQuality);
    });
  }

  function addPage(blob, isPdf, name, at, sharp) {
    var page = {
      blob: blob,
      isPdf: isPdf,
      url: isPdf ? null : URL.createObjectURL(blob),
      name: name,
      sharp: sharp === undefined ? null : sharp,
    };
    if (typeof at === 'number') pages[at] = page;
    else pages.push(page);
    return page;
  }

  /**
   * The JPEG's EXIF Orientation tag: 1 = upright, 2-8 = some flip/rotation, null = no EXIF.
   * We need this because the extraction API does not read image metadata at all — an orientation
   * that is not baked into the pixels simply never happens.
   */
  function jpegOrientation(buf) {
    var b = new DataView(buf);
    if (b.byteLength < 4 || b.getUint16(0) !== 0xffd8) return null;
    var off = 2;
    while (off + 4 <= b.byteLength) {
      var marker = b.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) return null;
      var len = b.getUint16(off + 2);
      if (marker === 0xffe1) {
        // APP1: "Exif\0\0" then a TIFF header whose byte order we must honour.
        if (off + 10 > b.byteLength || b.getUint32(off + 4) !== 0x45786966) return null;
        var tiff = off + 10;
        var little = b.getUint16(tiff) === 0x4949;
        var ifd = tiff + b.getUint32(tiff + 4, little);
        var count = b.getUint16(ifd, little);
        for (var i = 0; i < count; i++) {
          var entry = ifd + 2 + i * 12;
          if (b.getUint16(entry, little) === 0x0112) return b.getUint16(entry + 8, little);
        }
        return null;
      }
      if (marker === 0xffda) return null; // start of scan — no EXIF before the image data
      off += 2 + len;
    }
    return null;
  }

  // ---- importing files (camera / gallery / Genius Scan) ------------------------
  /**
   * Decode an image with its EXIF orientation applied, re-encode it at cfg.maxEdge, and score it.
   * Resolves {blob, sharp}; blob is null when the browser cannot decode the file at all (an
   * iPhone HEIC picked on Android is the realistic case).
   */
  function normalizeImage(file) {
    return new Promise(function (resolve) {
      var upright = false;
      var finish = function (source, w, h) {
        var sharp = null;
        try {
          sharp = sharpnessOf(source, w, h);
        } catch (e) {
          /* a decode we cannot measure still uploads — it just gets no verdict */
        }
        var s = Math.min(1, Math.sqrt(cfg.maxPixels / (w * h)), cfg.maxEdge / Math.max(w, h));
        // A camera photo is ALREADY a JPEG. Decoding and re-encoding it makes it a
        // second-generation JPEG, baking the first generation's artefacts in as signal and
        // re-quantising them. When it needs no resizing, the untouched original is the better
        // image. `upright` is not optional: the API does NOT read image metadata, so an EXIF
        // rotation only ever applies if we bake it into the pixels.
        if (s >= 1 && upright && file.type === 'image/jpeg' && file.size <= cfg.maxUploadBytes) {
          if (source.close) source.close();
          resolve({ blob: file, sharp: sharp });
          return;
        }
        var c = document.createElement('canvas');
        c.width = Math.round(w * s);
        c.height = Math.round(h * s);
        c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
        if (source.close) source.close();
        // Generation 2 deserves more headroom than a first encode from raw sensor pixels.
        c.toBlob(function (blob) {
          resolve({ blob: blob || file, sharp: sharp });
        }, 'image/jpeg', 0.95);
      };
      var decode = function () {
        if (typeof createImageBitmap !== 'function') return legacyDecode(file, finish, resolve);
        createImageBitmap(file, { imageOrientation: 'from-image' })
          .then(function (bmp) {
            finish(bmp, bmp.width, bmp.height);
          })
          .catch(function () {
            legacyDecode(file, finish, resolve);
          });
      };

      // Read the EXIF orientation before decoding, so finish() knows whether passing the original
      // through is safe. Any failure here just means "assume it needs rotating" — the re-encode
      // path is always correct, only slightly lossier.
      if (file.type === 'image/jpeg' && file.arrayBuffer) {
        file
          .arrayBuffer()
          .then(function (buf) {
            var o = jpegOrientation(buf);
            upright = o === null || o === 1;
          })
          .catch(function () {})
          .then(decode, decode);
      } else {
        decode();
      }
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
      fail({ blob: null, sharp: null });
    };
    img.src = url;
  }

  /**
   * Add picked files. Slots are reserved BEFORE the async decoding starts, so pages land in the
   * order they were chosen — pushing inside the decode callback meant a two-page invoice could
   * reach the model back-to-front whenever page 2 decoded first.
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
          rejected + ' קבצים לא נתמכים ולא נוספו — קובץ HEIC של אייפון לא ייקרא כאן. צלמו דרך "צלם עמוד" או שמרו כ-JPG.',
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
      normalizeImage(f).then(function (r) {
        if (r && r.blob) addPage(r.blob, false, 'page.jpg', base + i, r.sharp);
        else rejected += 1;
        settle();
      });
    });
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
      warn: $('scanBlurWarn'),
      err: $('scanErr'),
      send: $('btnSend'),
      progressWrap: $('scanProgress'),
      progressBar: $('scanProgressBar'),
      camInput: $('camInput'),
      fileInput: $('fileInput'),
      viewDlg: $('pageDlg'),
      viewImg: $('pageDlgImg'),
      viewCap: $('pageDlgCap'),
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

    $('btnCamera').addEventListener('click', function () {
      el.camInput.click();
    });
    $('btnFiles').addEventListener('click', function () {
      el.fileInput.click();
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

    sync();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
