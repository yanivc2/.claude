import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { currentUser } from './middleware/currentUser.js';
import { config } from './config.js';
import { formatIls, fromAgorot } from './lib/money.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import indexRoutes from './routes/index.js';
import supplierRoutes from './routes/suppliers.js';
import invoiceRoutes from './routes/invoices.js';
import paymentRoutes from './routes/payments.js';
import reportRoutes from './routes/reports.js';
import reconciliationRoutes from './routes/reconciliation.js';
import settingsRoutes from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  // Behind Vercel's proxy: trust X-Forwarded-* so req.protocol/secure/ip are correct.
  app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(currentUser);

  // View helpers available to every template.
  app.use((req, res, next) => {
    res.locals.formatIls = formatIls;
    res.locals.fromAgorot = fromAgorot;
    res.locals.vatRate = config.vatRate;
    res.locals.methodLabel = (m) =>
      ({ check: 'צ׳ק', cash: 'מזומן', credit: 'אשראי', transfer: 'העברה', batch: 'מקבץ' }[m] || m || 'צ׳ק');
    res.locals.paymentIdent = (p) => {
      switch (p.method) {
        case 'cash': return `מזומן · ${p.payer_name || ''}`;
        case 'credit': return `אשראי ****${p.card_last4 || ''}`;
        case 'transfer': return `העברה · ${p.reference || ''}`;
        case 'batch': return `מקבץ ${p.batch_number || ''} · אסמכתא ${p.reference || ''}`;
        default: return `צ׳ק ${p.check_number || ''}`;
      }
    };
    res.locals.path = req.path;
    next();
  });

  app.use('/', authRoutes);
  app.use('/account', accountRoutes);
  app.use('/', indexRoutes);
  app.use('/suppliers', supplierRoutes);
  app.use('/invoices', invoiceRoutes);
  app.use('/payments', paymentRoutes);
  app.use('/reports', reportRoutes);
  app.use('/reconciliation', reconciliationRoutes);
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
