// Sends a buyer their product. Importable (used by the sale watcher) and runnable standalone
// for a delivery test:  node deliver-product.js you@example.com "Your Name"
const path = require('path');
const { sendEmail } = require('./lib/email');
const { getConfigValue, findProductFile } = require('./lib/config');

async function deliverProduct({ email, name }) {
  const productName = getConfigValue('Name', 'your purchase');
  const firstName = (name || '').split(' ')[0] || 'there';
  const file = findProductFile();

  const subject = `Your copy of ${productName} 🎉`;
  const text =
    `Hi ${firstName},\n\n` +
    `Thank you so much — your order is confirmed! 💛\n\n` +
    (file
      ? `Your product is attached to this email. Just download it and dive in.\n\n`
      : `Your product is on its way — you'll receive the file shortly.\n\n`) +
    `If you have any questions, just reply to this email.\n\n` +
    `Cheering you on,\nThe team`;
  const html =
    `<p>Hi ${firstName},</p>` +
    `<p>Thank you so much — your order is confirmed! 💛</p>` +
    (file
      ? `<p><strong>Your product is attached to this email.</strong> Just download it and dive in.</p>`
      : `<p>Your product is on its way — you'll receive the file shortly.</p>`) +
    `<p>If you have any questions, just reply to this email.</p>` +
    `<p>Cheering you on,<br>The team</p>`;

  const attachments = file ? [{ path: file, filename: path.basename(file) }] : [];
  return sendEmail({ to: email, subject, text, html, attachments });
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
