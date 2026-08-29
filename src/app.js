// Build marker: 2026-08-05 — force a fresh production deploy of the latest main
// (page-access permissions) so it becomes the live Production build.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { currentUser } from './middleware/currentUser.js';
import { requirePageAccess, enforcePageScope } from './middleware/requireOwner.js';
import { config } from './config.js';
import { formatIls, fromAgorot } from './lib/money.js';
import authRoutes from './routes/auth.js';
import legalRoutes from './routes/legal.js';
import accountRoutes from './routes/account.js';
import indexRoutes from './routes/index.js';
import supplierRoutes from './routes/suppliers.js';
import invoiceRoutes from './routes/invoices.js';
import paymentRoutes from './routes/payments.js';
import reportRoutes from './routes/reports.js';
import reconciliationRoutes from './routes/reconciliation.js';
import settingsRoutes from './routes/settings.js';
import zclosingRoutes from './routes/zclosing.js';
import employeeRoutes from './routes/employees.js';
import scanRoutes from './routes/scan.js';
import productRoutes from './routes/products.js';
import contextRoutes from './routes/context.js';
import { isScanEnabled } from './services/appSettings.js';
import { depositStatus } from './services/deposits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bump on every deploy — shown on the login page so it's easy to confirm which build is live.
const BUILD_VERSION = '2026-08-15·88';

export function createApp() {
  const app = express();

  // Behind Vercel's proxy: trust X-Forwarded-* so req.protocol/secure/ip are correct.
  app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Never let the browser (or Safari's back-forward cache) serve a stale page. Runs BEFORE the
  // auth gate so it also covers the /login redirect and every other dynamic response — a fresh
  // deploy shows up immediately and financial data is never retained on-device. Static assets
  // were already served above by express.static and are unaffected.
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    next();
  });

  // Security headers (defense in depth). CSP allows the app's own inline scripts/handlers and
  // Google Fonts, but blocks external scripts, framing (clickjacking), and MIME sniffing.
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        // No 'wasm-unsafe-eval' and no `data:` in connect-src: both existed only for the vendored
        // OpenCV.js build behind the old auto-scanner, which is gone. Capture is now the phone's
        // own camera plus a sharpness check in plain canvas.
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    next();
  });

  app.use(currentUser);

  // View helpers available to every template.
  app.use((req, res, next) => {
    res.locals.formatIls = formatIls;
    res.locals.fromAgorot = fromAgorot;
    // Human date format across the app: 'YYYY-MM-DD' (or with a time suffix) -> 'DD/MM/YY'.
    // Leaves anything that isn't an ISO date untouched, and empty values as ''.
    res.locals.formatDate = (d) => {
      if (!d) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
      return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}` : String(d);
    };
    // 'YYYY-MM-DD HH:MM:SS' (or ISO) -> 'DD/MM/YY HH:MM'. Leaves non-timestamps untouched.
    res.locals.formatDateTime = (d) => {
      if (!d) return '';
      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(d));
      return m ? `${m[3]}/${m[2]}/${m[1].slice(2)} ${m[4]}:${m[5]}` : res.locals.formatDate(d);
    };
    // Phone links: a raw local number ('050-2288123') -> tel: and a wa.me deep link. WhatsApp
    // needs the international form, so a leading 0 becomes Israel's 972 country code.
    res.locals.telLink = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
    res.locals.waLink = (p) => {
      let d = String(p || '').replace(/\D/g, '');
      if (!d) return '';
      if (!d.startsWith('972')) d = d.startsWith('0') ? '972' + d.slice(1) : '972' + d;
      return 'https://wa.me/' + d;
    };
    res.locals.vatRate = config.vatRate;
    res.locals.cashCeilingAgorot = config.cashCeilingAgorot;
    res.locals.allocationThresholdAgorot = config.rules.allocationThresholdAgorot;
    res.locals.methodLabel = (m) =>
      ({ check: 'צ׳ק', cash: 'מזומן', credit: 'אשראי', transfer: 'העברה', batch: 'מקבץ', standing_order: 'הו"ק' }[m] || m || 'צ׳ק');
    res.locals.paymentIdent = (p) => {
      switch (p.method) {
        case 'cash': return `מזומן · ${p.payer_name || ''}`;
        case 'credit': return `אשראי ****${p.card_last4 || ''}`;
        case 'transfer': return `העברה · ${p.reference || ''}`;
        case 'standing_order': return `הו"ק · ${p.reference || ''}`;
        case 'batch': return `מקבץ ${p.batch_number || ''} · אסמכתא ${p.reference || ''}`;
        default: return `צ׳ק ${p.check_number || ''}`;
      }
    };
    res.locals.depositStatus = depositStatus; // lifecycle: הונפקה / הופקדה / הותאמה בבנק
    res.locals.path = req.path;
    res.locals.buildVersion = BUILD_VERSION;
    res.locals.checkPrintingApproved = config.checkPrinting.approved;
    next();
  });

  // Scan-feature entitlement: exposed to the nav (lock icon) and enforced at the /scan mount.
  // Default LOCKED until the owner enables it in Settings (foundation for a future scan package).
  app.use(async (req, res, next) => {
    try { res.locals.scanEnabled = req.user ? await isScanEnabled() : false; }
    catch { res.locals.scanEnabled = false; }
    next();
  });

  // Default-deny firewall for restricted roles (e.g. the register-closer). Runs before every
  // route so no detail/CSV/settings path can be reached outside a role's granted pages.
  app.use(enforcePageScope);

  app.use('/', authRoutes);
  app.use('/', legalRoutes);
  app.use('/account', accountRoutes);
  app.use('/context', contextRoutes); // active-store switch (OPEN_PATH → reachable by restricted roles)
  app.use('/', indexRoutes);
  app.use('/suppliers', requirePageAccess('nav_suppliers'), supplierRoutes);
  app.use('/invoices', requirePageAccess('nav_invoices'), invoiceRoutes);
  app.use('/payments', requirePageAccess('nav_payments'), paymentRoutes);
  app.use('/reports', reportRoutes); // per-sub-page access guarded inside reportRoutes
  app.use('/reconciliation', requirePageAccess('nav_reconciliation'), reconciliationRoutes);
  app.use('/zclosing', requirePageAccess('nav_zclosing'), zclosingRoutes);
  // Scan is locked behind the entitlement: when disabled, show the locked page (GET) or refuse
  // (other verbs) — a future scan package flips this on per customer.
  const scanGate = async (req, res, next) => {
    let enabled = false;
    try { enabled = await isScanEnabled(); } catch { enabled = false; }
    if (enabled) return next();
    if (req.method === 'GET') {
      return res.status(423).render('scan-locked', { title: 'צילום חשבוניות — נעול' });
    }
    return res.status(423).send('צילום חשבוניות אינו פעיל');
  };
  app.use('/scan', requirePageAccess('nav_scan'), scanGate, scanRoutes);
  app.use('/products', requirePageAccess('nav_products'), productRoutes);
  app.use('/employees', requirePageAccess('nav_employees'), employeeRoutes);
  app.use('/settings', settingsRoutes);

  // Unmatched route -> friendly page (instead of Express's raw "Cannot GET/POST ...").
  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'לא נמצא',
      message: `הדף המבוקש לא נמצא (${req.method} ${req.path}). נסה לרענן את הדף (Ctrl+Shift+R).`,
      rule: null,
    });
  });

  // Central error handler — renders domain errors nicely, logs the rest.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.name === 'NotFoundError' ? 404 : err.name === 'AuthError' ? 403 : 500;
    if (status === 500) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
    res.status(status).render('error', {
      title: 'שגיאה',
      message: err.message,
      rule: err.rule || null,
    });
  });

  return app;
}
