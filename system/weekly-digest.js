// Weekly summary to the seller's phone. Runs once a week (inside working hours).
// "How's it going?" in one glance: sales count + revenue over the last 7 days.
//
// A "sale" here is exactly what the sale watcher counts (check-sales.js listSales): paid checkouts,
// filtered by STRIPE_PRODUCT_IDS, plus other payments when SALES_INCLUDE_OTHER_PAYMENTS=true — so
// this text never contradicts the per-sale pings. (finance-report.js is the money view: every
// payment in the Stripe account, refunds and expenses included.)

const { weeklyGuardOrExit, markRan } = require('./lib/working-hours');
const { money } = require('./lib/stripe');
const { sendTelegram, loadEnv } = require('./lib/telegram');
const { getConfigValue } = require('./lib/config');
const { listSales } = require('./check-sales');

async function run() {
  weeklyGuardOrExit('weekly-digest');

  const env = loadEnv();
  const sinceSec = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const res = await listSales({ env, sinceSec });
  if (res.noKey) {
    console.log('Stripe not connected yet — no digest to send.');
    return;
  }
  if (!res.ok) {
    console.log(`Could not reach Stripe (status ${res.status}). Skipping this digest.`);
    return;
  }

  const count = res.sales.length;
  // Revenue per currency — an account that sells in two currencies must not have them added together.
  const byCur = {};
  for (const s of res.sales) { const c = String(s.currency || 'usd').toLowerCase(); byCur[c] = (byCur[c] || 0) + (s.amount_total || 0); }
  const revenue = Object.keys(byCur).length ? Object.entries(byCur).map(([c, cents]) => money(cents, c)).join(' + ') : money(0, 'usd');
  const productName = getConfigValue('Name', 'your product');

  const msg =
    `📊 Your week with ${productName}\n` +
    `Sales: ${count}\n` +
    `Revenue: ${revenue}\n` +
    (count === 0 ? `No sales yet this week — let's get some content out! 💪` : `Nice work — keep it going! 🎉`) +
    // Stripe didn't answer for payments made outside Stripe Checkout (asked only when
    // SALES_INCLUDE_OTHER_PAYMENTS=true): say the count may be short rather than let it look final.
    (res.chargesFailed ? `\n⚠️ I couldn't check payments made outside Stripe Checkout this time, so sales paid another way may be missing from these numbers.` : '');

  const ok = await sendTelegram(msg, env);
  console.log(msg);
  console.log(ok ? 'Weekly digest sent. ✅' : 'Digest not sent (Telegram not connected yet).');
  markRan('weekly-digest');
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    console.log(`Weekly digest hit an error: ${err.message}`);
    process.exitCode = 1;
  });
}
