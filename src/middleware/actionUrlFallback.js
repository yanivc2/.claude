/**
 * A GET to an action URL must land somewhere, not on the error page.
 *
 * THE BUG THIS FIXES: several POST handlers answer by RENDERING the list page rather than
 * redirecting to it (POST/Redirect/GET). That works — the user sees the right page — but it leaves
 * the browser parked on a URL that only accepts POST, e.g. `/employees/54/stores`. The next reload,
 * back/forward, or PWA restore issues a GET to that URL and hits "הדף המבוקש לא נמצא", which is
 * what the owner saw after saving an employee's stores. The action itself had succeeded.
 *
 * Rewriting fifty handlers to redirect is the textbook fix and a large, risky change. This is the
 * one-place version: it takes a GET whose path matches a route the app only registers for POST and
 * sends it to the nearest ancestor that DOES have a GET — `/employees/54/stores` → `/employees`. A
 * stale URL becomes the page the user expected instead of a dead end, and a route added tomorrow is
 * covered without touching this file, because the table is read from the router itself.
 *
 * It is a safety net, not a licence: a new POST handler should still redirect (303) after it acts.
 * What this guarantees is that forgetting to costs a redirect, not an error page.
 *
 * NOT applied to `/ingest/*` — those are machine endpoints (cron / the scraper runner) where a
 * stray GET must stay a 404 rather than be quietly redirected to a page.
 */

/** `/employees/:id/stores` → /^\/employees\/[^/]+\/stores$/ */
function toRegex(path) {
  const body = path
    .replace(/\/$/, '')
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body || '/'}/?$`);
}

/** Walk the mounted routers and collect every registered path per method. */
export function collectRoutes(app) {
  const found = { get: [], post: [] };
  const walk = (stack, prefix = '') => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          if (found[method]) found[method].push(prefix + layer.route.path);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        let mount = '';
        if (layer.regexp && !layer.regexp.fast_slash) {
          mount = layer.regexp.source
            .replace('^\\/', '/')
            .replace('\\/?(?=\\/|$)', '')
            .replace(/\\\//g, '/')
            .replace(/\$$/, '')
            .replace(/\(\?=.*$/, '');
        }
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  walk(app._router.stack);
  return found;
}

const EXCLUDED = /^\/ingest(\/|$)/;
const norm = (p) => p.replace(/\/$/, '') || '/';

function buildTables(app) {
  const routes = collectRoutes(app);
  const gets = routes.get.map((p) => ({ path: norm(p), re: toRegex(p) }));
  const literalGets = new Set(gets.filter((g) => !g.path.includes(':')).map((g) => g.path));
  const posts = routes.post.map(norm).filter((p) => !EXCLUDED.test(p));

  // An action URL is a path the app registers for POST and not for GET. Almost all of them simply
  // fall through to the end of the stack, and are handled LATE — after every router and every
  // permission guard, so an unauthorised caller still gets its 403 rather than a friendly redirect.
  //
  // A few cannot wait: a literal path SHADOWED by a param route (/invoices/pay-batch under
  // /invoices/:id) never falls through — the param route tries to load an invoice called
  // "pay-batch" and answers "הרשומה לא נמצאה". Those, and only those, are handled EARLY. Keeping
  // the early set to the shadowed ones keeps this middleware out of the way of the guards.
  const shadowed = (p) => gets.some((g) => g.path.includes(':') && g.re.test(p));
  const early = posts.filter((p) => !p.includes(':') && !literalGets.has(p) && shadowed(p)).map(toRegex);
  const late = posts
    .filter((p) => !early.some((re) => re.test(p.replace(/:[^/]+/g, 'x'))))
    .filter((p) => !gets.some((g) => g.re.test(p.replace(/:[^/]+/g, 'x'))))
    .map(toRegex);

  return { gets, early, late };
}

/**
 * @param {'early'|'late'} phase  'early' = before the feature routers, for the shadowed literals
 *                               only; 'late' = after them, for everything else.
 */
export function actionUrlFallback(app, phase = 'late') {
  // Built on first request, not at mount time: the early copy runs before the feature routers, so
  // the route table does not exist yet when it is created.
  let tables = null;

  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    if (!tables) tables = buildTables(app);
    const path = norm(req.path);
    if (!tables[phase].some((re) => re.test(path))) return next();

    // Nearest ancestor that answers GET — /employees/54/stores → /employees/54 → /employees.
    const parts = path.split('/').filter(Boolean);
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const candidate = `/${parts.slice(0, i).join('/')}`;
      if (tables.gets.some((g) => g.re.test(candidate))) return res.redirect(303, candidate);
    }
    return res.redirect(303, '/');
  };
}
