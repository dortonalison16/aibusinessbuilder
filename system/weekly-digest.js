// Weekly summary to the seller's phone. Runs once a week (inside working hours).
// "How's it going?" in one glance: sales count + revenue over the last 7 days.

const { guardOrExit } = require('./lib/working-hours');
const { stripeGet, money } = require('./lib/stripe');
const { sendTelegram } = require('./lib/telegram');
const { getConfigValue } = require('./lib/config');

async function run() {
  guardOrExit('weekly-digest');

  const sinceSec = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const res = await stripeGet(`/v1/checkout/sessions?limit=100&created[gte]=${sinceSec}`);
  if (res.error === 'no-key') {
    console.log('Stripe not connected yet — no digest to send.');
    return;
  }
  if (!res.ok) {
    console.log(`Could not reach Stripe (status ${res.status}). Skipping this digest.`);
    return;
  }

  const sessions = (res.data && res.data.data) || [];
  const paid = sessions.filter((s) => s.payment_status === 'paid');
  const count = paid.length;
  const currency = (paid[0] && paid[0].currency) || 'usd';
  const totalCents = paid.reduce((sum, s) => sum + (s.amount_total || 0), 0);
  const productName = getConfigValue('Name', 'your product');

  const msg =
    `📊 Your week with ${productName}\n` +
    `Sales: ${count}\n` +
    `Revenue: ${money(totalCents, currency)}\n` +
    (count === 0 ? `No sales yet this week — let's get some content out! 💪` : `Nice work — keep it going! 🎉`);

  const ok = await sendTelegram(msg);
  console.log(ok ? 'Weekly digest sent. ✅' : 'Digest not sent (Telegram not connected yet).');
}

run().catch((err) => {
  console.log(`Weekly digest hit an error: ${err.message}`);
});
