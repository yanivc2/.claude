import { getDb } from './index.js';

// Seed data from §2 of the brief. Companies, stores, bank accounts (1:1 store<->account),
// and the two operating roles. Suppliers start empty by design (§11.4) — every new supplier
// is created as `pending` and passes the owner approval gate (R6).
//
// tax_id for the three companies is left null pending confirmation (§2, §11.3).

const COMPANIES = [
  { key: 'al_haderech', name: 'על הדרך 24 שעות בע"מ', company_type: 'ltd' },
  { key: 'yaniv_rom', name: 'יניב רום יזמות בע"מ', company_type: 'ltd' },
  { key: 'pink_market', name: 'פינק מרקט י.ר. בע"מ', company_type: 'ltd' },
];

// store -> company key, plus its 1:1 bank account (all Bank Hapoalim, branch 428).
const STORES = [
  { company: 'al_haderech', name: "ג'וניור", branch: '428', account: '45550' },
  { company: 'al_haderech', name: 'סופר על הדרך', branch: '428', account: '420244' },
  { company: 'yaniv_rom', name: 'מידנייט', branch: '428', account: '432110' },
  { company: 'pink_market', name: 'פינק רשל"צ', branch: '428', account: '88772' },
];

const USERS = [
  { name: 'בעלים', role: 'owner' },
  { name: 'מזכירה', role: 'secretary' },
];

/**
 * Idempotently seed reference data. Existing rows (matched by natural key) are left
 * untouched, so running this repeatedly — or after adding a store — is safe.
 */
export function seed(db = getDb()) {
  const insertCompany = db.prepare(
    'INSERT INTO companies (name, company_type, tax_id) VALUES (?, ?, NULL)',
  );
  const findCompany = db.prepare('SELECT id FROM companies WHERE name = ?');
  const insertStore = db.prepare(
    'INSERT INTO stores (company_id, name) VALUES (?, ?)',
  );
  const findStore = db.prepare('SELECT id FROM stores WHERE name = ?');
  const insertAccount = db.prepare(
    `INSERT INTO bank_accounts (company_id, store_id, bank_name, branch, account_number, display_name)
     VALUES (?, ?, 'הפועלים', ?, ?, ?)`,
  );
  const findAccountByStore = db.prepare(
    'SELECT id FROM bank_accounts WHERE store_id = ?',
  );
  const insertUser = db.prepare('INSERT INTO users (name, role) VALUES (?, ?)');
  const findUser = db.prepare('SELECT id FROM users WHERE name = ? AND role = ?');

  const run = db.transaction(() => {
    const companyIdByKey = {};
    for (const c of COMPANIES) {
      let row = findCompany.get(c.name);
      if (!row) {
        const info = insertCompany.run(c.name, c.company_type);
        row = { id: info.lastInsertRowid };
      }
      companyIdByKey[c.key] = row.id;
    }

    for (const s of STORES) {
      const companyId = companyIdByKey[s.company];
      let store = findStore.get(s.name);
      if (!store) {
        const info = insertStore.run(companyId, s.name);
        store = { id: info.lastInsertRowid };
      }
      if (!findAccountByStore.get(store.id)) {
        const displayName = `${s.name} · הפועלים 428-${s.account}`;
        insertAccount.run(companyId, store.id, s.branch, s.account, displayName);
      }
    }

    for (const u of USERS) {
      if (!findUser.get(u.name, u.role)) {
        insertUser.run(u.name, u.role);
      }
    }
  });

  run();
}

// Allow `npm run seed`.
if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
  // eslint-disable-next-line no-console
  console.log('Seed complete.');
}
