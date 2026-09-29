// Email sender for auto-delivery. Uses nodemailer over the user's own SMTP (from .env).
// nodemailer is loaded lazily so the rest of the system works even before `npm install`.
const path = require('path');
const { loadEnv } = require('./telegram');

function emailConfigured(env) {
  const e = env || loadEnv();
  return Boolean(e.EMAIL_HOST && e.EMAIL_USER && e.EMAIL_PASS && e.EMAIL_FROM);
}

// For a customer-support reply, pass inReplyTo (the customer's Message-ID from lib/inbox.js body())
// so it lands in the same email thread, and replyTo so their answer comes back to the support inbox.
async function sendEmail({ to, subject, text, html, attachments, inReplyTo, replyTo }, env) {
  const e = env || loadEnv();
  if (!emailConfigured(e)) {
    return { ok: false, reason: 'not-configured', message: 'Email isn’t connected yet (missing EMAIL_* values in .env).' };
  }
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    return { ok: false, reason: 'no-nodemailer', message: 'Email engine not installed yet — run "npm install" in the system folder.' };
  }
  const transporter = nodemailer.createTransport({
    host: e.EMAIL_HOST,
    port: Number(e.EMAIL_PORT || 587),
    secure: Number(e.EMAIL_PORT) === 465, // 465 = SSL, otherwise STARTTLS
    auth: { user: e.EMAIL_USER, pass: e.EMAIL_PASS },
  });
  try {
    const threading = inReplyTo ? { inReplyTo, references: [inReplyTo] } : {};
    const info = await transporter.sendMail({
      from: e.EMAIL_FROM, to, subject, text, html, attachments, ...threading,
      ...(replyTo || e.GMAIL_USER ? { replyTo: replyTo || e.GMAIL_USER } : {}),
    });
    return { ok: true, id: info.messageId };
  } catch (err) {
    return { ok: false, reason: 'send-failed', message: friendlyError(err.message) };
  }
}

// The errors owners actually hit, in plain English. The certificate one is common on home laptops:
// antivirus "mail shield" features (Norton, Avast, AVG, Kaspersky…) intercept outgoing email and
// re-sign it with their own certificate, which the email engine correctly refuses to trust.
// On a Mac there is no "Mail Shield" to point at (it's usually a security app or the ISP), so the
// advice differs per platform.
function friendlyError(msg) {
  const m = String(msg || '');
  if (/certificate|self[- ]signed|CERT_|unable to verify/i.test(m)) {
    if (process.platform === 'darwin') {
      return 'Something on this network or Mac is intercepting outgoing email (some security apps do this, and some internet providers block email ports). Try a different network, or turn off email scanning in any security app, then click Save & test again.';
    }
    if (process.platform === 'win32') {
      return 'Your antivirus is scanning outgoing email and blocking it (this is common with Norton, Avast, AVG and Kaspersky "Mail Shield" / "Email scanning"). Turn off outgoing-email scanning in your antivirus settings, or add an exception for Node.js, then test again.';
    }
    return 'Something on this network or computer is intercepting outgoing email (a security app or your internet provider). Try a different network, or turn off email scanning in any security app, then click Save & test again.';
  }
  if (/Invalid login|Username and Password not accepted|535|EAUTH/i.test(m)) {
    return 'The email provider rejected the login. For Gmail it must be an APP password (with 2-Step Verification turned on), not your normal password.';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(m)) {
    return `Couldn't reach the email server (${m.split(' ')[0]}). Check your internet, and the server name and port in the email settings.`;
  }
  return m;
}

module.exports = { sendEmail, emailConfigured, friendlyError };
