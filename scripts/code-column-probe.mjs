// What IS the code column on this supplier's invoice — the tail of a barcode, or the supplier's
// own item number?
//
// Four suppliers print a "פריט" column (גלוברנדס, דובק) or no code at all (מוצרי איכות קנדיים,
// פיליפ מוריס), and the answer decides everything downstream. It must not be guessed, because
// guessing wrong is silent: `lookupByCodes()` resolves ANY printed code of 5+ digits by suffix,
// and `normalizeLine()` adopts a lone candidate with no corroboration at all. An internal item
// number that happens to end some EAN comes back badged `ברקוד מקוצר ✓`, pointing at an
// unrelated product, and nothing on the screen says otherwise.
//
//   node scripts/code-column-probe.mjs "גלוברנדס"
//   node scripts/code-column-probe.mjs --codes 104512,104513 --names "מרלבורו גולד,מרלבורו רד"
//
// Needs the real catalog, so run it against the live DB:
//   DATABASE_URL=postgres://… node scripts/code-column-probe.mjs "דובק"
//
// ── How it tells the two apart ────────────────────────────────────────────────
//
// Hit rate alone proves nothing, and this is the trap the whole script exists to avoid. In an
// 80,000-barcode catalog a *random* 5-digit number already ends some barcode more than half the
// time — so "all the codes were found" is the expected result whether they are barcode tails or
// pure coincidence. What separates them is hit rate measured AGAINST ITS OWN CHANCE BASELINE, and
// the baseline is sampled from this very catalog rather than assumed:
//
//   length   codes ending a barcode by pure chance      (≈, at 80k barcodes)
//      5     ~55%     ← uninformative on its own
//      6     ~8%
//      7     ~0.8%    ← a real tail hits ~100%; a coincidence hits ~1 in 125
//
// So for 6+ digits the hit rate is decisive on its own, and for 5-digit codes the discriminator
// is corroboration: does the product the code resolved to have anything to do with the
// description printed beside it? Real tails corroborate (on the Tnuva invoice the right answer
// scored 0.25-0.34 on name overlap and every wrong candidate scored exactly 0.00); coincidences
// land on a wine, a six-pack or a food coupon and score 0.
//
// A third signal needs no catalog at all: item numbers are ASSIGNED, so a supplier's own codes
// sit in a tight block (104512, 104513, 104520…). Barcode tails are scattered across the whole
// 10^L range. The median gap between sorted codes, compared to the uniform-spacing expectation,
// separates the two without a single query.
import { initBackend, getExecutor } from '../src/db/adapter.js';
import { rankCandidates } from '../src/lib/extractValidate.js';
import { eanChecksumOk } from '../src/lib/ean.js';
import { MIN_SUFFIX_LEN } from '../src/services/masterCatalog.js';

const argv = process.argv.slice(2);
const arg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const codesArg = arg('codes');
const namesArg = arg('names');
// Whatever is left once the flags and their values are removed is the supplier name.
const FLAGS_TAKING_VALUE = new Set(['--codes', '--names']);
const supplierArg = argv.find(
  (a, i) => !a.startsWith('--') && !FLAGS_TAKING_VALUE.has(argv[i - 1]),
) ?? null;

if (!supplierArg && !codesArg) {
  console.error('usage: node scripts/code-column-probe.mjs "<supplier name>"');
  console.error('       node scripts/code-column-probe.mjs --codes 1,2,3 [--names "א,ב,ג"]');
  process.exit(1);
}

/** Random L-digit strings drawn per length to measure the chance baseline empirically. */
const BASELINE_SAMPLES = 4000;

const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

await initBackend();
const x = getExecutor();

// ── the printed codes ─────────────────────────────────────────────────────────
// Either handed in on the command line, or read out of this supplier's own scans. The raw
// `extraction` is what we want, not `normalized`: it is what the model actually read off the
// page, before any human touched it.

/** @type {Array<{code: string, name: string|null, column: 'barcode'|'sku'}>} */
const printed = [];
let sourceLabel;

if (codesArg) {
  const names = (namesArg || '').split(',');
  codesArg.split(',').map((c) => c.trim()).filter(Boolean).forEach((code, i) => {
    printed.push({ code: digitsOf(code), name: (names[i] || '').trim() || null, column: 'barcode' });
  });
  sourceLabel = 'codes given on the command line';
} else {
  const supplier = await x.one('SELECT id, name FROM suppliers WHERE name LIKE ? ORDER BY id LIMIT 1', [
    `%${supplierArg}%`,
  ]);
  if (!supplier) {
    console.error(`no supplier matching "${supplierArg}"`);
    process.exit(1);
  }
  const drafts = await x.many(
    "SELECT id, supplier_id, extraction, normalized FROM invoice_drafts WHERE extraction IS NOT NULL ORDER BY id",
    [],
  );
  let used = 0;
  for (const d of drafts) {
    let extraction;
    let normalized;
    try {
      extraction = JSON.parse(d.extraction);
      normalized = d.normalized ? JSON.parse(d.normalized) : null;
    } catch {
      continue;
    }
    // The draft may carry the supplier explicitly (chosen on the capture screen) or only via the
    // match the validator made from the document itself.
    const belongs = d.supplier_id === supplier.id || normalized?.header?.supplierId === supplier.id;
    if (!belongs) continue;
    used++;
    for (const line of Array.isArray(extraction.lines) ? extraction.lines : []) {
      const name = (line?.name ?? '').trim() || null;
      for (const column of ['barcode', 'sku']) {
        const code = digitsOf(line?.[column]);
        if (code) printed.push({ code, name, column });
      }
    }
  }
  console.log(`supplier: ${supplier.name} (id ${supplier.id})`);
  sourceLabel = `${used} scanned draft(s)`;
  if (!printed.length) {
    console.error(`\nno printed codes found in ${sourceLabel} — scan one invoice from this supplier first,`);
    console.error('or pass the codes directly with --codes.');
    process.exit(1);
  }
}

console.log(`source:   ${sourceLabel}`);
console.log(`codes:    ${printed.length} printed (${new Set(printed.map((p) => p.code)).size} distinct)\n`);

// ── shape: what the codes look like, before the catalog has any say ───────────

const byColumn = new Map();
for (const p of printed) {
  if (!byColumn.has(p.column)) byColumn.set(p.column, []);
  byColumn.get(p.column).push(p);
}

/** column → median-gap ratio; well under 1 means the codes were assigned, not scattered. */
const clustering = new Map();

console.log('── shape ────────────────────────────────────────────────');
for (const [column, items] of byColumn) {
  const lengths = new Map();
  for (const p of items) lengths.set(p.code.length, (lengths.get(p.code.length) || 0) + 1);
  const spread = [...lengths.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}d×${n}`).join(' ');
  const fullGtin = items.filter((p) => p.code.length >= 12 && eanChecksumOk(p.code) !== false).length;
  const leadingZero = items.filter((p) => p.code.length > 1 && p.code.startsWith('0')).length;
  console.log(`  ${column.padEnd(8)} ${spread}`);
  console.log(`  ${' '.repeat(8)} ${fullGtin} pass a GTIN checksum at full length, ${leadingZero} carry a leading zero`);

  // Assigned item numbers cluster; barcode tails scatter. Compare the median gap between sorted
  // distinct codes against the gap you would see if they were spread evenly over the whole range.
  const nums = [...new Set(items.map((p) => p.code))]
    .filter((c) => c.length >= MIN_SUFFIX_LEN)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (nums.length >= 4) {
    const gaps = nums.slice(1).map((n, i) => n - nums[i]).sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];
    const modalLen = [...lengths.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const uniformGap = 10 ** modalLen / nums.length;
    // Uniformly scattered points sit at a median gap of ln2 ≈ 0.69 of the mean spacing, and a
    // small sample wanders well below that — so "scattered" is anything past 0.25. Assigned runs
    // land three or four orders of magnitude lower (a gap of 3 against an expected 50,000), which
    // is why the middle band is left explicitly unclear instead of split down the middle.
    const ratio = medianGap / uniformGap;
    clustering.set(column, ratio);
    console.log(
      `  ${' '.repeat(8)} median gap ${medianGap.toLocaleString()} vs ${Math.round(uniformGap).toLocaleString()} if scattered` +
        `  →  ${ratio < 0.05 ? 'CLUSTERED (looks assigned)' : ratio > 0.25 ? 'scattered (looks like tails)' : 'unclear'}`,
    );
  }
}

// ── the catalog, read once ────────────────────────────────────────────────────
// One pass, held in memory: the same 80k rows answer the real codes AND the random baseline, so
// the null model is measured on this exact catalog instead of assumed from its size.

const catalog = await x.many('SELECT barcode, name, manufacturer_name FROM master_catalog', []);
console.log(`\n── catalog ──────────────────────────────────────────────`);
console.log(`  ${catalog.length.toLocaleString()} barcodes loaded`);
if (!catalog.length) {
  console.error('\n  the catalog is empty — load קטלוג-על first (הגדרות ← טעינת קטלוג-על).');
  process.exit(1);
}

/** suffix → rows, for every suffix length we will ask about. Built once. */
const index = new Map();
function indexFor(len) {
  if (index.has(len)) return index.get(len);
  const map = new Map();
  for (const row of catalog) {
    const bc = String(row.barcode);
    if (bc.length < len) continue;
    const tail = bc.slice(-len);
    if (!map.has(tail)) map.set(tail, []);
    map.get(tail).push(row);
  }
  index.set(len, map);
  return map;
}

/** Share of random L-digit numbers that end at least one catalog barcode — the null model. */
function chanceAt(len) {
  const map = indexFor(len);
  let hits = 0;
  for (let i = 0; i < BASELINE_SAMPLES; i++) {
    let code = '';
    for (let d = 0; d < len; d++) code += Math.floor(Math.random() * 10);
    if (map.has(code)) hits++;
  }
  return hits / BASELINE_SAMPLES;
}

// ── the measurement ───────────────────────────────────────────────────────────

console.log('\n── do the printed codes live in the catalog? ────────────');
console.log('  column   len   codes   hit     by chance   verdict');

/** @type {Array<{column: string, len: number, n: number, hit: number, chance: number}>} */
const rows = [];
for (const [column, items] of byColumn) {
  const lengths = [...new Set(items.map((p) => p.code.length))].filter((l) => l >= MIN_SUFFIX_LEN).sort();
  for (const l of lengths) {
    const group = items.filter((p) => p.code.length === l);
    const map = indexFor(l);
    const hit = group.filter((p) => map.has(p.code)).length / group.length;
    const chance = chanceAt(l);
    rows.push({ column, len: l, n: group.length, hit, chance });
    // A tail is in the catalog because it IS one. A coincidence hits at the baseline rate.
    const lift = chance > 0 ? hit / chance : Infinity;
    const verdict =
      hit >= 0.7 && lift >= 3 ? 'BARCODE TAIL' : hit <= chance * 1.5 ? 'coincidence — own item number' : 'unclear';
    console.log(
      `  ${column.padEnd(8)} ${String(l).padStart(3)}   ${String(group.length).padStart(5)}   ` +
        `${(100 * hit).toFixed(0).padStart(3)}%    ${(100 * chance).toFixed(1).padStart(6)}%     ${verdict}`,
    );
  }
}

// ── corroboration: is the resolved product the one on the line? ───────────────
// The decisive test at 5 digits, where chance alone explains most hits. Reuses the shipped
// ranker, so what is measured here is exactly what the review screen would score.

console.log('\n── does the match agree with the printed description? ───');
let checked = 0;
let corroborated = 0;
const examples = [];
for (const p of printed) {
  if (p.code.length < MIN_SUFFIX_LEN) continue;
  const hits = indexFor(p.code.length).get(p.code);
  if (!hits || !p.name) continue;
  checked++;
  const ranked = rankCandidates(hits, { printedName: p.name, supplierName: supplierArg || null });
  const best = ranked[0];
  if (best.byName > 0) corroborated++;
  if (examples.length < 12) {
    examples.push({ code: p.code, printed: p.name, got: best.row.name, byName: best.byName, n: hits.length });
  }
}
if (!checked) {
  console.log('  no code both resolved and carried a printed description — nothing to corroborate.');
} else {
  console.log(`  ${corroborated}/${checked} resolved products share a word with the description printed beside them`);
  console.log(`  (a coincidence corroborates ~never; a real tail corroborates almost always)\n`);
  console.log('  code       printed                        resolved to                    overlap  cand');
  for (const e of examples) {
    console.log(
      `  ${e.code.padEnd(10)} ${String(e.printed).slice(0, 29).padEnd(30)} ${String(e.got).slice(0, 29).padEnd(30)} ` +
        `${e.byName.toFixed(2).padStart(6)}  ${String(e.n).padStart(4)}`,
    );
  }
}

// ── the answer ────────────────────────────────────────────────────────────────

console.log('\n── verdict ──────────────────────────────────────────────');
const main = rows.sort((a, b) => b.n - a.n)[0];
if (!main) {
  console.log('  no code of 5+ digits was printed — this supplier gives no code to match on.');
  console.log('  identity has to come from the product NAME, against this supplier\'s own catalog.');
} else {
  const rate = checked ? corroborated / checked : null;
  const lift = main.chance > 0 ? main.hit / main.chance : Infinity;
  const clustered = (clustering.get(main.column) ?? Infinity) < 0.05;
  if (main.hit >= 0.7 && lift >= 3 && (rate === null || rate >= 0.5)) {
    console.log('  SHORTENED BARCODE. The printed codes are tails of real EANs — the existing');
    console.log('  suffix matcher is the right mechanism and no new mapping is needed.');
    if (clustered) {
      console.log('  (…though the codes also sit in a tight block, which is unusual for tails —');
      console.log('   worth a second invoice before relying on it.)');
    }
  } else if (main.hit <= main.chance * 1.5 || (rate !== null && rate <= 0.15)) {
    console.log("  THE SUPPLIER'S OWN ITEM NUMBER.");
    // Which evidence carried it matters to whoever reads this, so say which one did.
    if (main.hit === 0) {
      console.log('  Not one printed code ends any barcode in the catalog. Whatever these numbers');
      console.log('  are, they are not tails of EANs.');
    } else {
      console.log('  The codes hit the catalog at about the rate random numbers of the same length');
      console.log('  do, so the hits are coincidences rather than identifications.');
    }
    if (rate !== null && rate <= 0.15) {
      console.log(`  And the products they landed on share no word with the printed description`);
      console.log(`  (${corroborated}/${checked}) — the hits point at unrelated products.`);
    }
    if (clustered) console.log('  They also sit in a tight assigned block, as item numbers do.');
    console.log('');
    console.log('  → Suffix matching MUST be switched off for this supplier. Left on, a lone');
    console.log('    accidental hit is adopted with no name check at all (extractValidate.js:389)');
    console.log('    and shows as `ברקוד מקוצר ✓` on an unrelated product.');
    console.log("  → Matching needs an item-number → barcode map from this supplier's own catalog.");
  } else {
    console.log('  INCONCLUSIVE on this sample. Read the two tables above rather than this line;');
    console.log('  more scanned invoices from this supplier will sharpen it.');
  }
}
console.log('');
process.exit(0);
