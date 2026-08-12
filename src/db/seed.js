import { getExecutor, tx } from './adapter.js';
import { config } from '../config.js';
import { hashPassword } from '../lib/auth.js';

// Seed data from §2 of the brief. Companies, stores, bank accounts (1:1 store<->account),
// and the two operating roles. Suppliers start empty by design (§11.4) — every new supplier
// is created as `pending` and passes the owner approval gate (R6).

const COMPANIES = [
  { key: 'al_haderech', name: 'על הדרך סופר', company_type: 'ltd', tax_id: '514737832' },
  { key: 'al_haderech_junior', name: 'על הדרך גוניור', company_type: 'ltd', tax_id: null },
  { key: 'yaniv_rom', name: 'יניב רום יזמות בע"מ', company_type: 'ltd', tax_id: '515325405' },
  { key: 'pink_market', name: 'פינק מרקט י.ר. בע"מ', company_type: 'ltd', tax_id: '516632627' },
];

// store -> company key, plus its 1:1 bank account (all Bank Hapoalim, branch 428).
const STORES = [
  { company: 'al_haderech_junior', name: "ג'וניור", branch: '428', account: '45550' },
  { company: 'al_haderech', name: 'סופר על הדרך', branch: '428', account: '420244' },
  { company: 'yaniv_rom', name: 'מידנייט', branch: '428', account: '432110' },
  { company: 'pink_market', name: 'פינק רשל"צ', branch: '428', account: '88772' },
];

function seedUsers() {
  return [
    { name: 'בעלים', role: 'owner', username: config.auth.seedOwnerUsername, password: config.auth.seedOwnerPassword },
    { name: 'מזכירה', role: 'secretary', username: config.auth.seedSecretaryUsername, password: config.auth.seedSecretaryPassword },
  ];
}

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

    for (const u of seedUsers()) {
      const existing = await t.one('SELECT id, password_hash FROM users WHERE name = ? AND role = ?', [u.name, u.role]);
      if (!existing) {
        await t.run('INSERT INTO users (name, role, username, password_hash) VALUES (?, ?, ?, ?)', [
          u.name,
          u.role,
          u.username,
          hashPassword(u.password),
        ]);
      } else if (existing.password_hash == null) {
        // Older row (pre-auth): backfill a login so the account can be used.
        await t.run('UPDATE users SET username = ?, password_hash = ? WHERE id = ?', [
          u.username,
          hashPassword(u.password),
          existing.id,
        ]);
      }
    }

    // Owner is "לי" in the UI (the switcher in Claude Design's prototype).
    await t.run("UPDATE users SET label = 'לי' WHERE role = 'owner' AND (label IS NULL OR label = '')", []);

    // Named team members with per-company access (הפרדת חברות). No password yet — each sets
    // their own via a WhatsApp invite link. Company access is granted in user_companies.
    const TEAM = [
      { name: 'ויקי', username: 'vicky', companies: ['al_haderech', 'al_haderech_junior', 'yaniv_rom', 'pink_market'] },
      { name: 'אדם', username: 'adam', companies: ['al_haderech'] },
      { name: 'רון', username: 'ron', companies: ['pink_market'] },
    ];
    for (const m of TEAM) {
      let row = await t.one('SELECT id FROM users WHERE username = ?', [m.username]);
      if (!row) {
        const info = await t.run(
          'INSERT INTO users (name, role, username, password_hash) VALUES (?, ?, ?, NULL)',
          [m.name, 'secretary', m.username],
        );
        row = { id: info.lastInsertRowid };
      }
      // (Re)assert this member's company grants.
      await t.run('DELETE FROM user_companies WHERE user_id = ?', [row.id]);
      for (const key of m.companies) {
        const cid = companyIdByKey[key];
        if (cid) await t.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [row.id, cid]);
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
