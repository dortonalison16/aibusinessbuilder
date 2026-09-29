// Email sender for auto-delivery. Uses nodemailer over the user's own SMTP (from .env).
// nodemailer is loaded lazily so the rest of the system works even before `npm install`.
const path = require('path');
const { loadEnv } = require('./telegram');

function emailConfigured(env) {
  const e = env || loadEnv();
  return Boolean(e.EMAIL_HOST && e.EMAIL_USER && e.EMAIL_PASS && e.EMAIL_FROM);
}

async function sendEmail({ to, subject, text, html, attachments }, env) {
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
    const info = await transporter.sendMail({ from: e.EMAIL_FROM, to, subject, text, html, attachments });
    return { ok: true, id: info.messageId };
  } catch (err) {
    return { ok: false, reason: 'send-failed', message: err.message };
  }
}

module.exports = { sendEmail, emailConfigured };
