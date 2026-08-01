import { getExecutor, tx } from './adapter.js';

// Seed data from §2 of the brief. Companies, stores, bank accounts (1:1 store<->account),
// and the two operating roles. Suppliers start empty by design (§11.4) — every new supplier
// is created as `pending` and passes the owner approval gate (R6).

const COMPANIES = [
  { key: 'al_haderech', name: 'על הדרך 24 שעות בע"מ', company_type: 'ltd', tax_id: '514737832' },
  { key: 'yaniv_rom', name: 'יניב רום יזמות בע"מ', company_type: 'ltd', tax_id: '515325405' },
  { key: 'pink_market', name: 'פינק מרקט י.ר. בע"מ', company_type: 'ltd', tax_id: '516632627' },
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
export async function seed(x = getExecutor()) {
  await tx(async (t) => {
    const companyIdByKey = {};
    for (const c of COMPANIES) {
      let row = await t.one('SELECT id, tax_id FROM companies WHERE name = ?', [c.name]);
      if (!row) {
        const info = await t.run('INSERT INTO companies (name, company_type, tax_id) VALUES (?, ?, ?)', [
          c.name,
          c.company_type,
          c.tax_id,
        ]);
        row = { id: info.lastInsertRowid };
      } else if (row.tax_id === null) {
        await t.run('UPDATE companies SET tax_id = ? WHERE id = ? AND tax_id IS NULL', [c.tax_id, row.id]);
      }
      companyIdByKey[c.key] = row.id;
    }

    for (const s of STORES) {
      const companyId = companyIdByKey[s.company];
      let store = await t.one('SELECT id FROM stores WHERE name = ?', [s.name]);
      if (!store) {
        const info = await t.run('INSERT INTO stores (company_id, name) VALUES (?, ?)', [companyId, s.name]);
        store = { id: info.lastInsertRowid };
      }
      const account = await t.one('SELECT id FROM bank_accounts WHERE store_id = ?', [store.id]);
      if (!account) {
        const displayName = `${s.name} · הפועלים 428-${s.account}`;
        await t.run(
          `INSERT INTO bank_accounts (company_id, store_id, bank_name, branch, account_number, display_name)
           VALUES (?, ?, 'הפועלים', ?, ?, ?)`,
          [companyId, store.id, s.branch, s.account, displayName],
        );
      }
    }

    for (const u of USERS) {
      const existing = await t.one('SELECT id FROM users WHERE name = ? AND role = ?', [u.name, u.role]);
      if (!existing) {
        await t.run('INSERT INTO users (name, role) VALUES (?, ?)', [u.name, u.role]);
      }
    }
  });
}

// Allow `npm run seed`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { initDb } = await import('./index.js');
  await initDb();
  await seed();
  // eslint-disable-next-line no-console
  console.log('Seed complete.');
}
