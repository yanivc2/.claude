// Thin HTTP client for Financy / open-finance.ai (Israeli Open Banking, Bank-of-Israel supervised).
//
// READ-ONLY by construction: only GET /data/accounts and GET /data/transactions are called, and the
// API key's scopes (read:accounts / read:transactions) cannot move money. Payment initiation exists
// in the provider's API and is deliberately NOT wired here.
//
// All JSON→row mapping lives in lib/financyMap.js; this file only fetches and pages.

import { config } from '../config.js';
import { RuleError } from './errors.js';

/** Is the integration configured at all? (No key → the UI offers setup instead of a sync button.) */
export function financyConfigured() {
  return Boolean(config.financy.apiKey);
}

/** The provider caps a page at 500 items; ask for that and follow `nextPage`. */
const PAGE_LIMIT = 500;
const MAX_PAGES = 40; // 20k transactions — a hard stop so a paging bug can't loop forever

function financyError(status, body) {
  const detail = String(body || '').slice(0, 300);
  if (status === 401) {
    return new RuleError('FINANCY', 'המפתח של Financy נדחה (401). בדוק את FINANCY_API_KEY בהגדרות Vercel.');
  }
  if (status === 403) {
    return new RuleError(
      'FINANCY',
      'ל-Financy אין הרשאה לפעולה הזו (403). ודא שהמנוי הוא Starter ומעלה ושהמפתח כולל הרשאות קריאה לחשבונות ולתנועות.',
    );
  }
  if (status === 404) return new RuleError('FINANCY', 'המשאב לא נמצא ב-Financy (404).');
  if (status === 429) return new RuleError('FINANCY', 'חריגה ממכסת הקריאות ב-Financy (429). נסה שוב מאוחר יותר.');
  return new RuleError('FINANCY', `שגיאה מ-Financy (${status}). ${detail}`);
}

/**
 * One GET against the provider. Returns the parsed JSON body.
 * @throws {RuleError} with a Hebrew, actionable message — never a raw fetch error.
 */
async function financyGet(path, params = {}) {
  if (!financyConfigured()) {
    throw new RuleError('FINANCY', 'חיבור Financy לא מוגדר. הוסף FINANCY_API_KEY בהגדרות Vercel.');
  }
  const url = new URL(String(config.financy.baseUrl).replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${config.financy.apiKey}`, accept: 'application/json' },
    });
  } catch (e) {
    throw new RuleError('FINANCY', `לא ניתן להתחבר ל-Financy: ${e.message}`);
  }
  if (!res.ok) throw financyError(res.status, await res.text().catch(() => ''));
  try {
    return await res.json();
  } catch {
    throw new RuleError('FINANCY', 'תשובה לא תקינה מ-Financy (לא JSON).');
  }
}

/** Follow `nextPage` until the feed is exhausted, collecting `items`. */
async function financyGetAll(path, params = {}) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await financyGet(path, { ...params, ...(cursor ? { nextPage: cursor } : {}) });
    const items = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
    out.push(...items);
    cursor = body?.nextPage || null;
    if (!cursor || items.length === 0) break;
  }
  return out;
}

/** Every account the connected user exposes (checking, card, loan, savings…). */
export async function fetchFinancyAccounts() {
  return financyGetAll('/data/accounts', { limit: PAGE_LIMIT });
}

/**
 * Transactions for ONE provider account in a date window.
 * `dateFrom`/`dateTo` are ISO 'YYYY-MM-DD'. The provider refuses `limit` together with a date
 * range, so paging here is by `nextPage` alone.
 */
export async function fetchFinancyTransactions({ accountId, dateFrom, dateTo }) {
  if (!accountId) throw new RuleError('FINANCY', 'חסר מזהה חשבון ב-Financy.');
  return financyGetAll('/data/transactions', { accountId, dateFrom, dateTo });
}
