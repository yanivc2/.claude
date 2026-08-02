import { config } from '../config.js';

// Minimal transactional email via Resend's HTTP API — no SDK/dependency, just fetch.
// With no RESEND_API_KEY configured, sendMail is a no-op that reports { sent: false } so
// callers can tell the user email isn't set up yet (the password-reset flow does exactly that).

/**
 * @param {{to:string, subject:string, html:string, text?:string}} msg
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function sendMail({ to, subject, html, text }) {
  if (!config.mail.enabled) return { sent: false, reason: 'not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.mail.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.mail.from, to, subject, html, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: `resend_${res.status}: ${body.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: String(err?.message || err) };
  }
}

export function mailEnabled() {
  return config.mail.enabled;
}
