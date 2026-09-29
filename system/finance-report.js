// Weekly finance report to the seller's phone (Automated version only).
//
//   node system/finance-report.js
//   node system/schedule-automation.js add --name finance-report --script finance-report.js --freq weekly --day Fri
//
// Real numbers only. Revenue comes straight from Stripe; expenses come from the optional local
// expense log the Finance Assistant keeps. Nothing here is estimated or projected — if a number
// isn't known, the report says so rather than guessing, because a made-up P&L is worse than none.

const fs = require('fs');
const path = require('path');
const { guardOrExit } = require('./lib/working-hours');
const { stripeGet, money } = require('./lib/stripe');
const { sendTelegram } = require('./lib/telegram');
const { ROOT } = require('./lib/config');

const EXPENSES = path.join(ROOT, 'Finance', 'expenses.json');
const DAY = 864e5;

// Pull succeeded, non-refunded charges in a window. Pages so a busier week never gets truncated.
async function revenueBetween(fromMs, toMs) {
  let charges = [];
  let startingAfter = null;
  for (let page = 0; page < 10; page++) {
    const qs = `/v1/charges?limit=100&created[gte]=${Math.floor(fromMs / 1000)}&created[lte]=${Math.floor(toMs / 1000)}`
      + (startingAfter ? `&starting_after=${startingAfter}` : '');
    const res = await stripeGet(qs);
    if (res.error === 'no-key') return { ok: false, reason: 'no-key' };
    if (!res.ok) return { ok: false, reason: `stripe-${res.status}` };
    const batch = (res.data && res.data.data) || [];
    charges = charges.concat(batch);
    if (!(res.data && res.data.has_more) || !batch.length) break;
    startingAfter = batch[batch.length - 1].id;
  }
  const good = charges.filter((c) => c.status === 'succeeded' && !c.refunded);
  const refunded = charges.filter((c) => c.refunded);
  const gross = good.reduce((s, c) => s + (c.amount || 0), 0);
  const refunds = refunded.reduce((s, c) => s + (c.amount_refunded || c.amount || 0), 0);
  const currency = (good[0] && good[0].currency) || (charges[0] && charges[0].currency) || 'usd';
  return { ok: true, gross, refunds, count: good.length, refundCount: refunded.length, currency };
}

// Optional local expense log, kept by the Finance Assistant. Shape: [{date,amount,category,note}]
// Amounts in major units (dollars), because that's how a human writes them down.
function expensesBetween(fromMs, toMs) {
  try {
    if (!fs.existsSync(EXPENSES)) return null;
    const rows = JSON.parse(fs.readFileSync(EXPENSES, 'utf8'));
    if (!Array.isArray(rows)) return null;
    const inWindow = rows.filter((r) => {
      const t = new Date(r.date).getTime();
      return Number.isFinite(t) && t >= fromMs && t <= toMs;
    });
    const total = inWindow.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const byCategory = {};
    for (const r of inWindow) {
      const k = r.category || 'uncategorized';
      byCategory[k] = (byCategory[k] || 0) + (Number(r.amount) || 0);
    }
    return { total, count: inWindow.length, byCategory };
  } catch (_) {
    return null;
  }
}

function trend(now, prev) {
  if (!prev) return now > 0 ? ' (first week with sales)' : '';
  const pct = Math.round(((now - prev) / prev) * 100);
  if (!Number.isFinite(pct) || pct === 0) return ' (about level with last week)';
  return pct > 0 ? ` (up ${pct}% on last week)` : ` (down ${Math.abs(pct)}% on last week)`;
}

async function run() {
  guardOrExit('finance-report');

  const now = Date.now();
  const thisWeek = await revenueBetween(now - 7 * DAY, now);

  if (!thisWeek.ok) {
    if (thisWeek.reason === 'no-key') {
      console.log('Stripe not connected yet — no finance report to send. (Add STRIPE_SECRET_KEY in .env.)');
      return;
    }
    console.log(`Could not reach Stripe (${thisWeek.reason}). Will try again next week.`);
    return;
  }

  const lastWeek = await revenueBetween(now - 14 * DAY, now - 7 * DAY);
  const cur = thisWeek.currency;
  const net = thisWeek.gross - thisWeek.refunds;
  const exp = expensesBetween(now - 7 * DAY, now);

  const lines = ['📊 Your week in numbers', ''];
  lines.push(`Revenue: ${money(thisWeek.gross, cur)}${lastWeek.ok ? trend(thisWeek.gross, lastWeek.gross) : ''}`);
  lines.push(`Sales:   ${thisWeek.count}`);
  if (thisWeek.count) lines.push(`Average order: ${money(Math.round(thisWeek.gross / thisWeek.count), cur)}`);

  if (thisWeek.refundCount) {
    lines.push('');
    lines.push(`Refunds: ${thisWeek.refundCount} (${money(thisWeek.refunds, cur)})`);
    lines.push(`Net:     ${money(net, cur)}`);
  }

  if (exp) {
    lines.push('');
    lines.push(`Expenses: ${money(Math.round(exp.total * 100), cur)} across ${exp.count} item(s)`);
    const top = Object.entries(exp.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [k, v] of top) lines.push(`  - ${k}: ${money(Math.round(v * 100), cur)}`);
    lines.push(`Profit:   ${money(net - Math.round(exp.total * 100), cur)}`);
  } else {
    lines.push('');
    lines.push('(No expenses logged this week — say "help me with my books" and I\'ll start tracking them, then this becomes a real profit figure rather than just revenue.)');
  }

  lines.push('');
  if (!thisWeek.count) {
    lines.push('No sales this week. That is genuinely normal early on — the useful question is whether');
    lines.push('enough people saw your page, not whether the page is wrong. Ask me "how am I doing?"');
    lines.push('and we will look at where the gap actually is.');
  } else if (thisWeek.refundCount && thisWeek.refundCount / thisWeek.count > 0.1) {
    lines.push('Refunds are running above 1 in 10. That usually traces back to onboarding, not the');
    lines.push('product — buyers who never got started are the ones who ask for their money back.');
    lines.push('Worth a look together.');
  } else {
    lines.push('Nothing needs your attention on the numbers. Ask "how am I doing?" any time for the');
    lines.push('bigger picture and the single best next move.');
  }

  const out = lines.join('\n');
  console.log('\n' + out);
  await sendTelegram(out);
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => console.log(`Finance report hit an error (will retry next week): ${err.message}`));
}
