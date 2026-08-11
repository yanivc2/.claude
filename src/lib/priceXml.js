// Parsing of חוק שקיפות המחירים price files (PriceFull XML) and of the Shufersal portal
// listing page — pure string work, no I/O. The XML is machine-generated and rigidly flat
// (<Item>…<ItemCode>…</ItemCode>…</Item>), so a scanner is safer than a dependency.

/** The five XML entities these files use. */
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Text of the first <name>…</name> inside a block; null when absent/empty. */
function tag(block, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  if (!m) return null;
  const v = unescapeXml(m[1]).trim();
  return v === '' ? null : v;
}

/** Decimal-shekel string → integer agorot (same rounding convention as the app). */
function agorot(v) {
  if (v === null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function numOrNull(v) {
  if (v === null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Manufacturer values that mean "unknown" in the published files (plus any dash run). */
const JUNK_MANUFACTURERS = new Set(['לא ידוע', 'כללי', 'unknown']);
function isJunkManufacturer(v) {
  return JUNK_MANUFACTURERS.has(v.toLowerCase()) || /^[-–—]+$/.test(v);
}

/**
 * Parse one PriceFull XML document into master-catalog items.
 * Keeps only items that can ever match a supplier-invoice barcode: universal item codes
 * (ItemType=1), not weighed (bIsWeighted!=1), 8-14 digits.
 *
 * @param {string} xml
 * @returns {Array<{barcode:string,name:string,manufacturerName:string|null,unitQty:string|null,
 *   quantity:number|null,qtyInPackage:number|null,retailPrice:number|null}>}
 */
export function parsePriceXml(xml) {
  const items = [];
  const s = String(xml || '');
  let pos = 0;
  for (;;) {
    const start = s.indexOf('<Item', pos);
    if (start === -1) break;
    // `<Item>` or `<Item attr=…>` — but not `<Items>` (the wrapper element).
    const afterTag = s[start + 5];
    if (afterTag !== '>' && afterTag !== ' ' && afterTag !== '\n' && afterTag !== '\r' && afterTag !== '\t') {
      pos = start + 5;
      continue;
    }
    const end = s.indexOf('</Item>', start);
    if (end === -1) break;
    const block = s.slice(start, end);
    pos = end + 7;

    const barcode = tag(block, 'ItemCode');
    if (!barcode || !/^\d{8,14}$/.test(barcode)) continue;
    const itemType = tag(block, 'ItemType');
    if (itemType !== null && itemType !== '1') continue; // internal chain code — can't match invoices
    if (tag(block, 'bIsWeighted') === '1') continue; // weighed items use internal codes
    const name = tag(block, 'ItemName');
    if (!name) continue;

    // Shufersal spells it ManufactureName (no r); other chains use ManufacturerName.
    let manufacturerName = tag(block, 'ManufacturerName') ?? tag(block, 'ManufactureName');
    if (manufacturerName && isJunkManufacturer(manufacturerName)) {
      manufacturerName = null;
    }

    items.push({
      barcode,
      name,
      manufacturerName,
      unitQty: tag(block, 'UnitQty'),
      quantity: numOrNull(tag(block, 'Quantity')),
      qtyInPackage: numOrNull(tag(block, 'QtyInPackage')),
      retailPrice: agorot(tag(block, 'ItemPrice')),
    });
  }
  return items;
}

/**
 * Extract the .gz file links from a price-portal listing page (Shufersal). Hrefs carry an
 * Azure SAS query string — returned verbatim, order preserved, duplicates dropped.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function extractGzLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /href="([^"]+?\.gz[^"]*)"/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const href = unescapeXml(m[1]);
    if (!seen.has(href)) {
      seen.add(href);
      out.push(href);
    }
  }
  return out;
}
