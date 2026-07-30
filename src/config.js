import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// R4 duplicate-warning window: same supplier + same total within this many days.
const DUP_WINDOW_DAYS = Number(process.env.DUP_WINDOW_DAYS ?? 30);

// R3 allocation-number threshold: tax invoice with amount_before_vat over this
// (in agorot) and no allocation number is soft-blocked. 5,000 ILS from 1.6.2026 (§10.2).
const ALLOCATION_THRESHOLD_AGOROT = Number(
  process.env.ALLOCATION_THRESHOLD_AGOROT ?? 5000 * 100,
);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH
    ? path.resolve(projectRoot, process.env.DB_PATH)
    : path.join(projectRoot, 'data', 'ap-control.sqlite'),
  uploadsDir: process.env.UPLOADS_DIR
    ? path.resolve(projectRoot, process.env.UPLOADS_DIR)
    : path.join(projectRoot, 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  projectRoot,
  rules: {
    dupWindowDays: DUP_WINDOW_DAYS,
    allocationThresholdAgorot: ALLOCATION_THRESHOLD_AGOROT,
  },
};
