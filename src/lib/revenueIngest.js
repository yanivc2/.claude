// Pure helpers for the nightly "דוח פדיון" email intake (POST /ingest/revenue-report).
//
// The report travels: Aviv POS → the owner's Gmail → a small Apps Script in that Gmail
// (lib/revenueIngestScript.js) → this endpoint. Three things the file itself does not say, so
// they are decided here, each from the most reliable source available:
//   • the SECRET   — REVENUE_INGEST_SECRET if set, else derived from SESSION_SECRET (so the owner
//                    never has to touch Vercel; the app shows it inside the ready-made script);
//   • the DATE     — explicit ?date= › the POS stamp in the file name › the email's send time ›
//                    yesterday. A stamp/send time before 06:00 Israel belongs to the previous day:
//                    the nightly report for the 16th is generated at 23:59 or just after midnight;
//   • the STORE    — ?store=<id>, or the branch name from the POS subject ("סניף: 3 מידנייט")
//                    matched to exactly one store name. Never guessed: no unique match = refused.

import { createHmac } from 'node:crypto';
import { config } from '../config.js';

/** The shared secret the intake checks, or null when none can be trusted. */
export function revenueIngestSecret() {
  if (config.revenueIngestSecret) return config.revenueIngestSecret;
  // A per-process random session secret (local dev) would change on every cold start.
  if (!config.auth.hasExplicitSecret) return null;
  return createHmac('sha256', config.auth.sessionSecret).update('ap-control:revenue-ingest').digest('hex');
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function minusDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' + hour of an instant, in Israel time. */
function israelParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** A local Israel day+hour → the business day it reports on (before 06:00 = the day before). */
function businessDay(day, hour) {
  return hour < 6 ? minusDay(day) : day;
}

/**
 * The business day a report covers.
 * @param {{date?:string, fileName?:string, sent?:string, today?:string}} src
 * @returns {{date:string, from:'date'|'file'|'sent'|'default'}}
 */
export function reportDateFrom({ date, fileName, sent, today } = {}) {
  const d = String(date || '').trim();
  if (ISO.test(d)) return { date: d, from: 'date' };
  // POS file names carry a local stamp: "פדיון-A4_20261016235900_115.xls" = 16/10 23:59:00.
  const m = /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:_|\.)/.exec(String(fileName || ''));
  if (m) return { date: businessDay(`${m[1]}-${m[2]}-${m[3]}`, Number(m[4])), from: 'file' };
  const t = sent ? new Date(sent) : null;
  if (t && !Number.isNaN(t.getTime())) {
    const { day, hour } = israelParts(t);
    return { date: businessDay(day, hour), from: 'sent' };
  }
  const base = today || israelParts(new Date()).day;
  return { date: minusDay(base), from: 'default' };
}

const isSheet = (f) => /\.(xlsx?|csv)$/i.test(f.originalname || '') || /excel|spreadsheet|csv/i.test(f.mimetype || '');
const isPdf = (f) => /\.pdf$/i.test(f.originalname || '') || /pdf/i.test(f.mimetype || '');
const named = (f) => /פדיון|pidion/i.test(f.originalname || '');

/**
 * The revenue file among the attachments: a sheet named "פדיון", else a PDF named "פדיון" (the
 * same report — the POS can send either), else the first sheet. An unnamed PDF is never taken:
 * the POS mails carry other PDFs too (z_####.pdf, other reports).
 */
export function pickReportFile(files) {
  const list = files || [];
  const sheets = list.filter(isSheet);
  return sheets.find(named) || list.filter((f) => isPdf(f) && !isSheet(f)).find(named) || sheets[0] || null;
}

/** Comparison key for a store / branch name: no quotes, geresh, punctuation or spaces. */
export function normName(s) {
  return String(s || '').toLowerCase().replace(/["'׳״`.,\-_\s]/g, '');
}

/**
 * The one store a POS branch name refers to, or null. A store matches when either name contains
 * the other ("סופר" ↔ "סופר על הדרך"); a branch the POS left unnamed ("null") never matches, and
 * two candidates are a refusal, not a pick.
 */
export function resolveStoreByBranch(stores, branchName) {
  const key = normName(branchName);
  if (!key || key === 'null' || key.length < 3) return null;
  const exact = (stores || []).filter((s) => normName(s.name) === key);
  if (exact.length === 1) return exact[0];
  const hits = (stores || []).filter((s) => {
    const n = normName(s.name);
    return n && (n.includes(key) || key.includes(n));
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * POS branches the till never named. The subject then reads "סניף: 1 null", so the name cannot
 * match a store — the owner said which store it is (17/10: "סניף 1 זה ג'וניור"). Consulted ONLY
 * when the POS gives no name; the store is still found by name, so renaming it is caught (422).
 */
export const POS_BRANCH_ALIASES = { 1: "ג'וניור" };

/** "[ דו"ח ] 3: יומי סניף: 3 מידנייט " → { no: '3', name: 'מידנייט' }; an unnamed branch → its alias. */
export function branchFromSubject(subject) {
  const m = /סניף:\s*(\d+)\s*([^\n]*?)\s*$/.exec(String(subject || ''));
  if (!m) return { no: '', name: '' };
  const named = m[2] && normName(m[2]) !== 'null';
  return { no: m[1], name: named ? m[2] : (POS_BRANCH_ALIASES[m[1]] || m[2]) };
}

/**
 * The PDF prints the store it was issued for ("ג'וניור בעיר", "פינק מרקט י. ר. בע"מ"). When that name
 * points at ONE store and it is not the store the report is being filed under, the file is someone
 * else's: a branch's whole month would land on the wrong store. Returns that other store, else null
 * (no title, or a title that matches nothing — "על הדרך 24 שעות בע"מ" vs "סופר על הדרך" — is allowed).
 */
export function storeTitleConflict(stores, title, storeId) {
  if (!title) return null;
  const hit = resolveStoreByBranch(stores, title);
  return hit && Number(hit.id) !== Number(storeId) ? hit : null;
}
