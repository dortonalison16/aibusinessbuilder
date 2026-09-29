// The automated business loop. Runs on a schedule (inside working hours):
//   1. Ask Stripe for recent PAID checkouts
//   2. For each NEW one: email the buyer their product + ping the seller on Telegram
//   3. Remember it so it's never handled twice
//
// Why polling (not webhooks): webhooks need a public server URL, which a non-technical person
// running this on their own laptop doesn't have. Polling every working-hour is reliable and
// needs zero hosting.

const { guardOrExit } = require('./lib/working-hours');
const { stripeGet, money } = require('./lib/stripe');
const { sendTelegram } = require('./lib/telegram');
const { readSet, writeSet } = require('./lib/store');
const { deliverProduct } = require('./deliver-product');
const { getConfigValue } = require('./lib/config');
const ghl = require('./lib/ghl');

// Tag-safe slug for the CRM tag (lowercase, hyphens, no punctuation).
const slug = (s) => String(s || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

async function run() {
  // Refuse to run outside the user's working hours (safe even if the OS fires us oddly).
  guardOrExit('sale-watch');

  // Page through checkout sessions (newest first) so a higher-volume seller never drops a paid
  // order that fell past the first 100. Safety stop at 10 pages (1000 sessions) — far more than a
  // laptop polling hourly will ever accrue between runs.
  let sessions = [];
  let startingAfter = null;
  for (let page = 0; page < 10; page++) {
    const qs = `/v1/checkout/sessions?limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
    const res = await stripeGet(qs);
    if (res.error === 'no-key') {
      console.log('Stripe not connected yet — nothing to check. (Add STRIPE_SECRET_KEY in .env.)');
      return;
    }
    if (!res.ok) {
      console.log(`Could not reach Stripe (status ${res.status}). Will try again next run.`);
      return;
    }
    const batch = (res.data && res.data.data) || [];
    sessions = sessions.concat(batch);
    if (!(res.data && res.data.has_more) || batch.length === 0) break;
    startingAfter = batch[batch.length - 1].id;
  }

  const paid = sessions.filter((s) => s.payment_status === 'paid');
  const seen = readSet('seen-sales');
  const productName = getConfigValue('Name', 'your product');

  let handled = 0;
  for (const s of paid) {
    if (seen.has(s.id)) continue;
    const email = s.customer_details && s.customer_details.email;
    const name = s.customer_details && s.customer_details.name;
    const amount = money(s.amount_total, s.currency);

    // Deliver the product (only if we have an email + delivery is configured).
    let deliveredOk = false;
    let deliveryNote = 'no email on file';
    if (email) {
      const r = await deliverProduct({ email, name });
      deliveredOk = Boolean(r.ok);
      deliveryNote = r.ok ? `emailed to ${email}` : `FAILED — ${r.reason}`;
    }

    // Hand the buyer to their CRM so their own onboarding emails fire automatically. Entirely
    // optional — if GHL isn't configured this is a no-op and nothing downstream changes.
    let crmNote = null;
    if (email && ghl.isConfigured()) {
      const g = await ghl.addBuyer({ email, name, tags: ['customer', 'purchased-' + slug(productName)] });
      crmNote = g.ok ? 'added to your CRM and tagged' : `CRM add FAILED — ${g.reason}`;
    }

    // Ping the seller — plain text. Report the whole chain, not just the sale: "you made a sale"
    // is exciting, but "sale made AND product delivered" is what lets them close the laptop. And
    // if a link broke, say so loudly — a silent delivery failure becomes an angry customer and a
    // refund that they'd otherwise find out about days later.
    const lines = [`💸 New sale! ${productName} — ${amount}`, `Buyer: ${email || 'unknown'}`];
    lines.push(`${deliveredOk ? '✅' : '⚠️'} Product ${deliveryNote}`);
    if (crmNote) lines.push(`${crmNote.includes('FAILED') ? '⚠️' : '✅'} ${crmNote}`);
    lines.push(deliveredOk
      ? 'Nothing needed from you.'
      : 'They have PAID and not received it yet — tell me and I\'ll sort it now.');
    await sendTelegram(lines.join('\n'));

    // Persist immediately after EACH sale — so a crash or the laptop sleeping mid-loop can never
    // cause this buyer to be emailed (and the seller pinged) twice on the next run.
    seen.add(s.id);
    writeSet('seen-sales', seen);
    handled++;
    console.log(`Handled sale ${s.id}: ${amount} — ${delivered}`);
  }

  if (handled === 0) console.log('No new sales this run. ✅');
  else console.log(`Done — ${handled} new sale(s) handled. ✅`);
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    console.log(`Sale check hit an error (will retry next run): ${err.message}`);
  });
}
