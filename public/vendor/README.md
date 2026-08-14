# public/vendor

Third-party assets served **verbatim** to the browser. Nothing here is written by hand.

Why a root-level `public/` and not `src/public/`: `vercel.json` rewrites `/(.*)` to the serverless
function, but Vercel checks the filesystem *before* applying rewrites — so files here can be served
straight from the CDN instead of streaming 10MB through Node on every download.

That CDN path is an optimisation, not a guarantee, so it is belt-and-braces: `vercel.json` also
lists `public/**` in the function's `includeFiles`, and `src/app.js` mounts this directory with
`express.static`. Whichever layer answers, `/vendor/opencv.js` resolves — and local development
serves the exact same paths. Leave both in place; dropping either one turns a missing file into a
307 to the login page, which is what a static asset behind the auth gate looks like.

## opencv.js

| | |
|---|---|
| Version | OpenCV 4.9.0 (official prebuilt `opencv.js`) |
| Source | https://docs.opencv.org/4.9.0/opencv.js |
| SHA-256 | `4d7b85e2e12ea0bd088f491c311d620a45b53d1489b7f065b4492a230bda243a` |
| Size | 10.2 MB raw · ~3.3 MB gzipped on the wire |
| License | Apache 2.0 |

This is a SINGLE_FILE emscripten build — the WASM binary is embedded as base64 inside the JS, so
there is no separate `.wasm` file to serve and no extra network round trip.

It is **never** loaded on page render. `src/public/scan-capture.js` injects the `<script>` tag only
when the capture screen actually starts the camera, and `src/public/sw.js` then keeps it in a
cache-first runtime cache, so an employee pays the download once per device.

Used by the invoice scanner for live page-edge detection and perspective correction
(`cvtColor` / `GaussianBlur` / `Canny` / `findContours` / `Laplacian` / `warpPerspective`).

To upgrade: download the new build, update the version + SHA-256 above, and re-run the manual
capture checks on a real phone — the auto-shutter is tuned against this build's behaviour.
