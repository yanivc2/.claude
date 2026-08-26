// Bag-barcode scanner (deposit bags). Progressive enhancement: uses the browser-native
// BarcodeDetector + the phone camera where available (Android/Chrome); everywhere else (iOS/Safari,
// no camera permission) it falls back to a manual prompt. No external library — CSP-safe.
//
// Usage: a button with data-bag-scan="<id-of-target-input>" (optionally data-bag-form to submit the
// input's form after a successful scan). apBagScan is also callable directly.
(function () {
  function fillAndMaybeSubmit(input, value, submit) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit && input.form) (input.form.requestSubmit ? input.form.requestSubmit() : input.form.submit());
  }

  function manual(input, submit) {
    var v = window.prompt('סריקת ברקוד אינה נתמכת במכשיר זה — הקלד את מספר השקית:');
    if (v && v.trim()) fillAndMaybeSubmit(input, v.trim(), submit);
  }

  window.apBagScan = function (input, opts) {
    opts = opts || {};
    var submit = !!opts.submit;
    var Detector = window.BarcodeDetector;
    if (!Detector || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return manual(input, submit);
    }
    // Build a full-screen scanning overlay with a live camera preview.
    var overlay = document.createElement('div');
    overlay.className = 'bag-scan-overlay';
    overlay.innerHTML =
      '<div class="bag-scan-box">'
      + '<video class="bag-scan-video" playsinline muted></video>'
      + '<div class="bag-scan-hint">כוון את המצלמה אל ברקוד השקית</div>'
      + '<div class="bag-scan-actions">'
      + '<button type="button" class="btn btn-secondary" data-bs-manual>הקלדה ידנית</button>'
      + '<button type="button" class="btn btn-secondary" data-bs-cancel>ביטול</button>'
      + '</div></div>';
    document.body.appendChild(overlay);
    var video = overlay.querySelector('.bag-scan-video');
    var stream = null, raf = 0, done = false;
    var detector = new Detector();

    function cleanup() {
      done = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.querySelector('[data-bs-cancel]').addEventListener('click', cleanup);
    overlay.querySelector('[data-bs-manual]').addEventListener('click', function () { cleanup(); manual(input, submit); });

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (s) {
        stream = s; video.srcObject = s; video.play();
        function tick() {
          if (done) return;
          detector.detect(video).then(function (codes) {
            if (done) return;
            if (codes && codes.length && codes[0].rawValue) {
              var val = String(codes[0].rawValue).trim();
              cleanup();
              fillAndMaybeSubmit(input, val, submit);
            } else {
              raf = requestAnimationFrame(tick);
            }
          }).catch(function () { raf = requestAnimationFrame(tick); });
        }
        raf = requestAnimationFrame(tick);
      })
      .catch(function () { cleanup(); manual(input, submit); });
  };

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-bag-scan]') : null;
    if (!btn) return;
    e.preventDefault();
    var input = document.getElementById(btn.getAttribute('data-bag-scan'));
    if (input) window.apBagScan(input, { submit: btn.hasAttribute('data-bag-submit') });
  });
})();
