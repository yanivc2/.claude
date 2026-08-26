// Docs guard for the doc-sync skill. Fails (exit 1) if a load-bearing rule was dropped from
// CLAUDE.md, the INDEX pointer is gone, INDEX.md lost a required section, or a doc references a
// file that no longer exists. Docs-only — never touches app behaviour. Run after any doc edit.
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
let bad = 0;
const fail = (m) => { console.log('FAIL ' + m); bad++; };
const ok = (m) => console.log('ok   ' + m);

// 1) CLAUDE.md must keep every standing-rule section (wording may change; the rule may not vanish).
const claude = read('CLAUDE.md');
const REQUIRED_CLAUDE = [
  'Deploy & branch workflow', 'Multi-session work', 'Run & test',
  'Stack & core patterns', 'permissions', 'Adding a DB column', 'Gotchas',
];
for (const s of REQUIRED_CLAUDE) (claude.includes(s) ? ok : fail)(`CLAUDE.md keeps "${s}"`);

// 2) Load-bearing facts that must survive any trim.
const REQUIRED_FACTS = [
  ['apnew ap-control-split:main', 'push command'],
  ['BUILD_VERSION', 'version bump rule'],
  ['עדכן מסד נתונים', 'DB-upgrade reminder'],
  ['TEST_PG=1', 'both-dialects test rule'],
  ['schema', 'schema-in-3-places'],
  ['INDEX.md', 'pointer to INDEX'],
];
for (const [needle, what] of REQUIRED_FACTS) (claude.includes(needle) ? ok : fail)(`CLAUDE.md keeps ${what}`);

// 3) INDEX.md exists with its required sections.
if (!existsSync(root + 'INDEX.md')) fail('INDEX.md exists');
else {
  const idx = read('INDEX.md');
  for (const s of ['אינווריאנטים נושאי-עומס', 'פרוטוקול שינוי', 'קליסט לפני דחיפה']) {
    (idx.includes(s) ? ok : fail)(`INDEX.md keeps "${s}"`);
  }
}

// 4) Every src/... path mentioned in either doc must exist (catches stale/renamed references).
for (const doc of ['CLAUDE.md', 'INDEX.md']) {
  const text = read(doc);
  const paths = new Set((text.match(/\bsrc\/[A-Za-z0-9_./-]+\.(js|ejs|sql|css)\b/g) || []));
  for (const p of paths) if (!existsSync(root + p)) fail(`${doc} references missing ${p}`);
  ok(`${doc}: ${paths.size} src paths checked`);
}

console.log(bad ? `\n${bad} DOC CHECK FAILURE(S)` : '\nDOCS OK');
process.exit(bad ? 1 : 0);
