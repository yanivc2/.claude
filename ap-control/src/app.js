import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { currentUser } from './middleware/currentUser.js';
import { formatIls, fromAgorot } from './lib/money.js';
import indexRoutes from './routes/index.js';
import supplierRoutes from './routes/suppliers.js';
import invoiceRoutes from './routes/invoices.js';
import paymentRoutes from './routes/payments.js';
import reportRoutes from './routes/reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(currentUser);

  // View helpers available to every template.
  app.use((req, res, next) => {
    res.locals.formatIls = formatIls;
    res.locals.fromAgorot = fromAgorot;
    res.locals.path = req.path;
    next();
  });

  app.use('/', indexRoutes);
  app.use('/suppliers', supplierRoutes);
  app.use('/invoices', invoiceRoutes);
  app.use('/payments', paymentRoutes);
  app.use('/reports', reportRoutes);

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
