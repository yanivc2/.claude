// Reset (or set) a user's login password. Runs against whatever DATABASE_URL points to
// (local SQLite if unset, or your Neon Postgres when set).
//
//   node src/db/set-password.js <username> <new-password>
//   e.g.  node src/db/set-password.js owner MySecret123
//
// Idempotent and safe to re-run. Prints the available usernames if the one given isn't found.

import { initDb, getExecutor } from './index.js';
import { hashPassword } from '../lib/auth.js';

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  // eslint-disable-next-line no-console
  console.error('שימוש: node src/db/set-password.js <שם-משתמש> <סיסמה-חדשה>');
  process.exit(1);
}

await initDb();
const x = getExecutor();
const info = await x.run('UPDATE users SET password_hash = ? WHERE username = ?', [hashPassword(password), username]);

if (info.changes && info.changes > 0) {
  // eslint-disable-next-line no-console
  console.log(`✓ הסיסמה של "${username}" עודכנה. אפשר להתחבר עכשיו.`);
} else {
  const users = await x.many('SELECT username, role FROM users ORDER BY id', []);
  // eslint-disable-next-line no-console
  console.log(`לא נמצא משתמש בשם "${username}". המשתמשים הקיימים:`);
  // eslint-disable-next-line no-console
  for (const u of users) console.log(`  - ${u.username || '(ללא שם משתמש)'} · ${u.role}`);
}
process.exit(0);
