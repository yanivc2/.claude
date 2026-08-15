// "הסקיל של הספק" — what a supplier's invoice LOOKS LIKE, learned from its own scans.
//
// The problem this solves: every supplier lays its invoice out differently. Tnuva prints a
// shortened barcode in the code column; another prints its own catalogue number there; one has a
// separate כ.בודד column and one does not; some never print an allocation number at all. A single
// generic prompt will always lose on those details, and it loses them silently — the numbers come
// back plausible and wrong.
//
// So every supplier accumulates a profile of its own, and the profile rides along with the next
// photo of that supplier's invoice. The goal is the one the owner stated: after the photo, the
// system already knows where each element sits on THIS supplier's page.
//
// Two things it learns, both from data we already have and neither of them guesswork:
//
//   1. **Structure**, derived from what the extraction actually returned across scans. If 31 of 31
//      line codes were 5-8 digits and none passed a GTIN checksum, that column is a shortened
//      barcode — that is a measurement, not an assumption. If no scan ever produced an allocation
//      number, this supplier does not print one.
//   2. **Corrections**, from the diff between what the model read (`extraction`) and what a human
//      approved (`normalized`). A correction only becomes a rule once it REPEATS, so one typo
//      never turns into an instruction that poisons every future scan.
//
// Cost note: the hints go into the USER message, never into the `cache_control: ephemeral` system
// prompt, which must stay byte-identical for the prompt cache to hold. Profiles are free.

import { getExecutor } from '../db/adapter.js';
import { eanChecksumOk } from '../lib/ean.js';
import { parseDateILS, toAgorotFromNumber } from '../lib/extractValidate.js';

/** Consecutive corrected-nothing scans before a profile is called ready. */
export const READY_STREAK = 3;
/** How often the same field must be corrected before it becomes a hint. */
export const CORRECTION_THRESHOLD = 2;

/** An empty profile — the shape everything else assumes. */
export function emptyProfile() {
  return {
    samples: 0,
    cleanStreak: 0,
    layout: { codes: { total: 0, short: 0, full: 0, minLen: null, maxLen: null }, unitQuantity: 0, allocation: 0, sku: 0, packCost: 0 },
    corrections: {},
    hints: [],
    updatedAt: null,
  };
}

export function parseProfile(raw) {
  if (!raw) return emptyProfile();
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...emptyProfile(), ...p, layout: { ...emptyProfile().layout, ...(p.layout || {}) } };
  } catch {
    return emptyProfile();
  }
}

/**
 * How far along this supplier's skill is.
 * @returns {{state: 'new'|'learning'|'ready', label: string, samples: number, streak: number}}
 */
export function readiness(profile) {
  const p = parseProfile(profile);
  if (!p.samples) return { state: 'new', label: 'חדש — עדיין לא צולמה חשבונית', samples: 0, streak: 0 };
  if (p.cleanStreak >= READY_STREAK) {
    return { state: 'ready', label: 'מוכן — הזיהוי יציב', samples: p.samples, streak: p.cleanStreak };
  }
  return {
    state: 'learning',
    label: `לומד — ${p.cleanStreak}/${READY_STREAK} צילומים רצופים בלי תיקון`,
    samples: p.samples,
    streak: p.cleanStreak,
  };
}

/**
 * Header fields whose correction is worth learning from, with everything needed to compare the
 * model's raw output against the human-approved value.
 *
 * `to` is the load-bearing part. The extraction and the approved draft do not speak the same
 * language: the model returns `06/08/2026` and decimal shekels, the draft holds `2026-08-06` and
 * integer agorot. Comparing them raw makes the VALIDATOR's own normalization look like a human
 * correction — every single scan would report four fixes, the streak would never grow, and the
 * profile would fill with instructions about fields nobody ever touched. So each field is put
 * through the same conversion the validator applies before the two are compared.
 */
const LEARNED_FIELDS = {
  invoice_number: { key: 'invoiceNumber', label: 'מספר החשבונית', to: (v) => String(v ?? '').trim() },
  allocation_number: { key: 'allocationNumber', label: 'מספר ההקצאה', to: (v) => String(v ?? '').replace(/\D/g, '') },
  invoice_date: { key: 'invoiceDate', label: 'תאריך החשבונית', to: (v) => parseDateILS(v) ?? '' },
  amount_before_vat: { key: 'amountBeforeVat', label: 'סכום לפני מע"מ', to: toAgorotFromNumber },
  vat_amount: { key: 'vatAmount', label: 'מע"מ', to: toAgorotFromNumber },
  total_amount: { key: 'totalAmount', label: 'סה"כ לתשלום', to: toAgorotFromNumber },
  supplier_name: { key: 'supplierName', label: 'שם הספק', to: (v) => String(v ?? '').trim() },
};

const same = (a, b) => String(a ?? '') === String(b ?? '');

/**
 * Fold one approved scan into a supplier's profile. Pure — no I/O, so it is trivially testable.
 *
 * @param {object|string|null} current the stored profile
 * @param {{extraction: object|null, normalized: object}} scan what the model read and what a human approved
 * @param {string} at timestamp
 * @returns {object} the new profile
 */
export function learnFromScan(current, { extraction, normalized }, at) {
  const p = parseProfile(current);
  const lines = Array.isArray(normalized?.lines) ? normalized.lines : [];

  // --- structure, measured from the lines themselves ---------------------------
  const layout = { ...p.layout, codes: { ...p.layout.codes } };
  for (const line of lines) {
    const code = String(line.barcode ?? '').replace(/\D/g, '');
    if (code) {
      layout.codes.total++;
      // A code that is a valid GTIN length AND passes its check digit is a real barcode; a short
      // one that cannot be is this supplier printing the tail of the EAN.
      if (code.length >= 12 && eanChecksumOk(code) !== false) layout.codes.full++;
      else if (code.length >= 4 && code.length <= 9) {
        layout.codes.short++;
        layout.codes.minLen = layout.codes.minLen === null ? code.length : Math.min(layout.codes.minLen, code.length);
        layout.codes.maxLen = layout.codes.maxLen === null ? code.length : Math.max(layout.codes.maxLen, code.length);
      }
    }
    if (line.unitQuantity !== null && line.unitQuantity !== undefined) layout.unitQuantity++;
    if (line.sku) layout.sku++;
    if (line.packCost !== null && line.packCost !== undefined) layout.packCost++;
  }
  if (normalized?.header?.allocationNumber) layout.allocation++;

  // --- corrections, from the diff between the model and the human --------------
  const corrections = { ...p.corrections };
  let corrected = 0;
  if (extraction && normalized?.header) {
    for (const [key, field] of Object.entries(LEARNED_FIELDS)) {
      const read = extraction[key];
      // Only count a field the model actually produced: turning a null into a value is the human
      // filling a gap, not correcting a misreading, and the two deserve different lessons.
      if (read === null || read === undefined || read === '') continue;
      if (!same(field.to(read), normalized.header[field.key])) {
        corrections[key] = (corrections[key] || 0) + 1;
        corrected++;
      }
    }
  }

  return {
    ...p,
    samples: p.samples + 1,
    // The streak is what "ready" is measured on: three scans in a row that a human waved through
    // untouched. One correction sends it back to zero, because that is the honest signal.
    cleanStreak: corrected === 0 ? p.cleanStreak + 1 : 0,
    layout,
    corrections,
    updatedAt: at,
  };
}

/**
 * The profile as Hebrew instructions for the extractor — the part that actually travels with the
 * next photo. Only states what the data supports; an empty profile produces nothing at all.
 *
 * @returns {string[]} one instruction per line
 */
export function hintsFor(profile) {
  const p = parseProfile(profile);
  const out = [];
  const c = p.layout.codes;

  if (c.total >= 3 && c.short > c.full) {
    const range = c.minLen === c.maxLen ? `${c.minLen}` : `${c.minLen}-${c.maxLen}`;
    out.push(
      `עמודת הקוד בחשבוניות של ספק זה מכילה ברקוד מקוצר (${range} ספרות) ולא ברקוד מלא — ` +
        'החזר אותו כפי שהוא מודפס בשדה barcode, בלי להשלים ספרות ובלי לנחש.',
    );
  } else if (c.total >= 3 && c.full > c.short) {
    out.push('בחשבוניות של ספק זה מודפס ברקוד מלא (12-13 ספרות) — החזר אותו בשדה barcode.');
  }
  if (p.samples >= 2 && p.layout.unitQuantity > 0) {
    out.push('לחשבוניות של ספק זה יש עמודת כמות יחידות בודדות (כ.בודד) בנוסף לכמות הראשית — החזר אותה ב-unit_quantity.');
  }
  if (p.samples >= 3 && p.layout.allocation === 0) {
    out.push('ספק זה אינו מדפיס מספר הקצאה — אם לא ראית מספר בן 9 ספרות במפורש, החזר allocation_number ריק.');
  }
  if (p.samples >= 2 && p.layout.sku > 0) {
    out.push('לחשבוניות של ספק זה יש עמודת מק"ט נפרדת מהברקוד — החזר אותה ב-sku.');
  }

  // A correction becomes an instruction only once it has repeated: a single human fix is as
  // likely to be a typo as a rule, and a wrong rule is worse than no rule.
  for (const [key, count] of Object.entries(p.corrections)) {
    if (count >= CORRECTION_THRESHOLD && LEARNED_FIELDS[key]) {
      out.push(`שים לב במיוחד ל${LEARNED_FIELDS[key].label} — בחשבוניות של ספק זה הוא נקרא שגוי ${count} פעמים ותוקן ידנית.`);
    }
  }

  // Anything the owner wrote by hand comes last and is never rewritten by the learner.
  for (const h of Array.isArray(p.hints) ? p.hints : []) {
    const t = String(h || '').trim();
    if (t) out.push(t);
  }
  return out;
}

// ---- persistence -------------------------------------------------------------

export async function getProfile(supplierId, x = getExecutor()) {
  const row = await x.one('SELECT scan_profile FROM suppliers WHERE id = ?', [supplierId]);
  return parseProfile(row?.scan_profile);
}

/** Fold an approved scan into the supplier's profile and store it. */
export async function recordScan(supplierId, { extraction, normalized }, at, x = getExecutor()) {
  if (!supplierId) return null;
  const current = await getProfile(supplierId, x);
  const next = learnFromScan(current, { extraction, normalized }, at);
  await x.run('UPDATE suppliers SET scan_profile = ? WHERE id = ?', [JSON.stringify(next), supplierId]);
  return next;
}

/** Replace the owner's free-text hints (the learned parts are untouched). */
export async function setHints(supplierId, hints, x = getExecutor()) {
  const current = await getProfile(supplierId, x);
  const next = { ...current, hints: (Array.isArray(hints) ? hints : []).map((h) => String(h).trim()).filter(Boolean) };
  await x.run('UPDATE suppliers SET scan_profile = ? WHERE id = ?', [JSON.stringify(next), supplierId]);
  return next;
}
