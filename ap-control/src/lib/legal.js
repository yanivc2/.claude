// Legal / compliance page data (privacy notice + accessibility statement).
//
// These pages are public (reachable without login) so data subjects and any auditor can read
// them. The *content* lives in the EJS views under views/legal/; this module holds only the
// small set of facts that change over time (operator companies, contact addresses, dates) so
// they stay in one place and can be overridden per-deployment via env.
//
// NOTE: this is operator-supplied factual content, not legal advice. The drafts were reviewed
// against the Privacy Protection Law (incl. Amendment 13) and the accessibility regulations,
// but the operator should have counsel confirm before treating them as final.

// The three operating companies behind the system (קבוצת יניב רום).
export const companies = [
  { name: 'יניב רום יזמות בע"מ', number: '515325405', address: 'הרצל 220, רחובות' },
  { name: 'פינק מרקט י.ר בע"מ', number: '516632627', address: 'הגדוד העברי 52, ראשון לציון' },
  { name: 'על הדרך 24 שעות בע"מ', number: '514737832', address: '' },
];

export const groupName = 'קבוצת יניב רום';

// Contact address for privacy / data-subject requests and for accessibility feedback.
// Override in any deployment with LEGAL_CONTACT_EMAIL (a business inbox is preferable to a
// personal one for a public-facing notice).
export const contactEmail = process.env.LEGAL_CONTACT_EMAIL || 'yanivc2@gmail.com';

// Accessibility coordinator (רכז נגישות). Override with ACCESSIBILITY_CONTACT if separate.
export const accessibilityContact = process.env.ACCESSIBILITY_CONTACT || contactEmail;

// Response window we commit to for data-subject requests (days).
export const responseWindowDays = Number(process.env.LEGAL_RESPONSE_DAYS ?? 30);

// Last review dates shown on each page. Bump when the text changes.
export const privacyUpdated = '1 באוגוסט 2026';
export const accessibilityUpdated = '1 באוגוסט 2026';

// External processors named in the privacy notice (kept here so both the notice and any future
// data-map view stay consistent).
export const processors = [
  { name: 'Vercel', role: 'אירוח האפליקציה ואחסון סריקות חשבוניות (Blob)', region: 'ארה"ב' },
  { name: 'Neon', role: 'מסד הנתונים (PostgreSQL)', region: 'ארה"ב' },
  { name: 'Resend', role: 'משלוח מיילים (איפוס סיסמה)', region: 'ארה"ב' },
];

export const legalLocals = {
  companies,
  groupName,
  contactEmail,
  accessibilityContact,
  responseWindowDays,
  privacyUpdated,
  accessibilityUpdated,
  processors,
};
