// Sends a buyer their product. Importable (used by the sale watcher) and runnable standalone
// for a delivery test:  node deliver-product.js you@example.com "Your Name"
//
// Two ways to deliver, in this order:
//   1. PRODUCT_DOWNLOAD_URL in .env — emails a link (best for big, image-heavy PDFs).
//   2. The single PDF in the Product/ folder — attached to the email (see lib/config productFileStatus).
// If NEITHER exists, delivery FAILS loudly instead of promising "you'll receive it shortly" —
// a buyer who paid and got nothing is the fastest route to a refund, so the seller must hear.
const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./lib/email');
const { loadEnv } = require('./lib/telegram');
const { getConfigValue, getConfigField, productFileStatus } = require('./lib/config');
const undelivered = require('./lib/undelivered');

// Most mail providers reject messages over ~25 MB, and attachments grow ~33% when encoded.
const MAX_ATTACH_BYTES = 18 * 1024 * 1024;

const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function deliverProduct({ email, name }, envIn) {
  const env = envIn || loadEnv();
  const productName = getConfigValue('Name', 'your purchase');
  const firstName = (name || '').trim().split(/\s+/)[0] || 'there';
  const link = env.PRODUCT_DOWNLOAD_URL || '';
  const status = link ? { file: null } : productFileStatus();
  const file = status.file;
  const signOff = env.EMAIL_SIGN_OFF || getConfigField('Brand & Look', 'Business name') || 'The team';

  if (!link && !file) {
    return { ok: false, reason: 'no-product', message: status.message };
  }
  if (file) {
    const size = fs.statSync(file).size;
    if (size > MAX_ATTACH_BYTES) {
      return { ok: false, reason: 'too-big', message: `The product file is ${(size / 1048576).toFixed(1)} MB — too big to email reliably. Put it on Google Drive/Dropbox and set PRODUCT_DOWNLOAD_URL instead.` };
    }
  }

  const subject = `Your copy of ${productName} 🎉`;
  const text =
    `Hi ${firstName},\n\n` +
    `Thank you so much — your order is confirmed! 💛\n\n` +
    (link
      ? `Here's your download link:\n${link}\n\nSave it somewhere safe so you can come back to it anytime.\n\n`
      : `Your product is attached to this email. Just download it and dive in.\n\n`) +
    `If you have any questions, just reply to this email.\n\n` +
    `Cheering you on,\n${signOff}`;
  const html =
    `<p>Hi ${escHtml(firstName)},</p>` +
    `<p>Thank you so much — your order is confirmed! 💛</p>` +
    (link
      ? `<p><strong><a href="${escHtml(link)}">Click here to download ${escHtml(productName)}</a></strong></p><p>Save this email so you can come back to it anytime.</p>`
      : `<p><strong>Your product is attached to this email.</strong> Just download it and dive in.</p>`) +
    `<p>If you have any questions, just reply to this email.</p>` +
    `<p>Cheering you on,<br>${escHtml(signOff)}</p>`;

  const attachments = file ? [{ path: file, filename: path.basename(file) }] : [];
  const r = await sendEmail({ to: email, subject, text, html, attachments }, env);
  // A buyer who got their product (automatic retry or a hand re-send) is no longer outstanding.
  if (r && r.ok) undelivered.removeEmail(email);
  return r;
}

module.exports = { deliverProduct };

// Standalone test mode
if (require.main === module) {
  const [, , email, ...nameParts] = process.argv;
  if (!email) {
    console.log('Usage: node deliver-product.js you@example.com "Your Name"');
    process.exit(1);
  }
  deliverProduct({ email, name: nameParts.join(' ') }).then((r) => {
    if (r.ok) console.log(`SUCCESS: Delivery email sent to ${email}. ✅ Ask them to check inbox/spam.`);
    else { console.log(`NOT SENT: ${r.message}`); process.exitCode = 1; }
  });
}
