// קטלוג-על importer — downloads PriceFull files from the public Shufersal price-transparency
// portal (חוק שקיפות המחירים), parses them, and upserts the products into master_catalog.
// CLI only (never runs inside Vercel):
//
//   npm run catalog:import                      # local SQLite (or Neon when DATABASE_URL is set)
//   npm run catalog:import -- --stores 5,10     # explicit store ids instead of the first two
//   npm run catalog:import -- --url <file.gz>   # skip discovery, import the given file(s)
//   npm run catalog:import -- --no-json         # don't write data/master-catalog.json
//
// The portal lists per-store gz files; one big branch's PriceFull is the whole range, a second
// store only adds barcodes the first one missed.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { initDb } from '../db/index.js';
import { decodeBuffer } from '../lib/decodeText.js';
import { parsePriceXml, extractGzLinks } from '../lib/priceXml.js';
import { importCatalogItems, exportGrouped } from '../services/masterCatalog.js';

const PORTAL = 'https://prices.shufersal.co.il/';
/**
 * PriceFull listing endpoint (verified live): the portal's category filter is an AJAX partial —
 * catID=2 is "PricesFull", storeId=0 lists every store's newest file (20 per page).
 */
const PORTAL_PRICEFULL = `${PORTAL}FileObject/UpdateCategory?catID=2&storeId=0`;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_LISTING_PAGES = 5;
const DEFAULT_STORE_COUNT = 2;

function parseArgs(argv) {
  const args = { urls: [], stores: null, json: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.urls.push(argv[++i]);
    else if (a === '--stores') args.stores = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--no-json') args.json = false;
  }
  return args;
}

async function fetchWithRetry(url, { asBuffer = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'ap-control-catalog-import/1.0' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

/**
 * Store id out of a PriceFull filename — PriceFull<chain>-<subchain>-<store>-<date>-<time>.gz
 * (e.g. PriceFull7290027600007-001-005-20260811-030000.gz → '005').
 */
function storeIdOf(url) {
  const m = /PriceFull\d+-\d+-(\d+)-/i.exec(url);
  return m ? String(Number(m[1])) : null; // '005' → '5', matching the --stores argument
}

/** Newest PriceFull link per store, first `count` distinct stores in listing order. */
async function discover(count, wantedStores) {
  const links = [];
  const byStore = new Map();
  const pages = [PORTAL_PRICEFULL];
  for (let p = 2; p <= MAX_LISTING_PAGES; p++) pages.push(`${PORTAL_PRICEFULL}&page=${p}`);
  for (const page of pages) {
    try {
      const html = await fetchWithRetry(page);
      links.push(...extractGzLinks(html));
    } catch (err) {
      console.warn(`  דילוג על עמוד רשימה (${err.message})`);
    }
    for (const url of links.filter((u) => /PriceFull/i.test(u))) {
      const store = storeIdOf(url);
      if (!store) continue;
      if (wantedStores && !wantedStores.includes(store)) continue;
      if (!byStore.has(store)) byStore.set(store, url); // listing is newest-first
      if (byStore.size >= count) return [...byStore.entries()];
    }
  }
  return [...byStore.entries()];
}

const args = parseArgs(process.argv.slice(2));
await initDb(); // picks SQLite locally / Neon via DATABASE_URL, and self-provisions the table

let sources; // [storeId|null, url][]
if (args.urls.length) {
  sources = args.urls.map((u) => [storeIdOf(u), u]);
} else {
  console.log('מאתר קבצי PriceFull בפורטל שופרסל…');
  sources = await discover(args.stores?.length || DEFAULT_STORE_COUNT, args.stores);
  if (sources.length === 0) {
    console.error('לא נמצאו קבצי PriceFull — מבנה הפורטל השתנה? אפשר לעקוף עם --url <קובץ.gz>');
    process.exit(1);
  }
}

const merged = new Map(); // barcode → item, first file wins
const storeIds = [];
for (const [store, url] of sources) {
  console.log(`מוריד ${url}`);
  const gz = await fetchWithRetry(url, { asBuffer: true });
  const xml = decodeBuffer(zlib.gunzipSync(gz));
  const items = parsePriceXml(xml);
  let added = 0;
  for (const item of items) {
    if (!merged.has(item.barcode)) {
      merged.set(item.barcode, item);
      added++;
    }
  }
  storeIds.push(store || '?');
  console.log(`  סניף ${store || '?'}: ${items.length} פריטים תקינים, ${added} חדשים למיזוג`);
}

console.log(`מייבא ${merged.size} פריטים לקטלוג-העל…`);
const result = await importCatalogItems([...merged.values()], {
  chain: 'shufersal',
  store: storeIds.join(','),
});
console.log(`  נוספו ${result.inserted} · עודכנו ${result.updated} · ללא שינוי ${result.unchanged}`);

const grouped = await exportGrouped();
console.log(`יצרנים בקטלוג: ${grouped.manufacturers.length}. עשרת הגדולים:`);
for (const m of grouped.manufacturers.slice(0, 10)) {
  console.log(`  ${m.manufacturer}: ${m.itemCount}`);
}

if (args.json) {
  const out = path.join(process.cwd(), 'data', 'master-catalog.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(grouped, null, 1), 'utf8');
  console.log(`נכתב ${out}`);
}
process.exit(0);
