// Weekly finance report to the seller's phone (Auto-Pilot edition only).
//
//   node system/finance-report.js
//   node system/schedule-automation.js add --name finance-report --script finance-report.js --freq weekly --day Fri
//
// Real numbers only. Revenue comes straight from Stripe; expenses come from the optional local
// expense log the Finance Assistant keeps. Nothing here is estimated or projected — if a number
// isn't known, the report says so rather than guessing, because a made-up P&L is worse than none.

const fs = require('fs');
const path = require('path');
const { weeklyGuardOrExit, markRan } = require('./lib/working-hours');
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
  // Gross counts every successful payment (refunded ones too); refunds (full or partial) are then
  // subtracted once for net. (Excluding refunded charges from gross AND subtracting them again used
  // to count every refund twice.)
  const good = charges.filter((c) => c.status === 'succeeded');
  const refunded = good.filter((c) => c.refunded || Number(c.amount_refunded) > 0);
  const gross = good.reduce((s, c) => s + (c.amount || 0), 0);
  const refunds = refunded.reduce((s, c) => s + (Number(c.amount_refunded) || (c.refunded ? c.amount : 0) || 0), 0);
  const currency = (good[0] && good[0].currency) || (charges[0] && charges[0].currency) || 'usd';
  // Stripe accounts can take several currencies; the totals above add the raw amounts together, so
  // the report labels that plainly instead of pretending it all came in as one currency.
  const currencies = [...new Set(good.map((c) => String(c.currency || '').toLowerCase()).filter(Boolean))];
  return { ok: true, gross, refunds, count: good.length, refundCount: refunded.length, currency, currencies };
}

// An expense is logged as a bare day ("2026-10-03"), which new Date() reads as UTC midnight — 10am
// in Sydney, 8pm the evening BEFORE in Toronto — so a "today" expense could land outside (or an
// 8-day-old one inside) the week. Same rule as check-sales.js --since: a bare day is midnight on
// the owner's clock. Anything else (a full timestamp) is parsed as-is. Returns ms, or NaN.
function parseLocalDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : new Date(s).getTime();
}

// Optional local expense log, kept by the Finance Assistant. Shape: [{date,amount,category,note}]
// Amounts in major units (dollars), because that's how a human writes them down.
function expensesBetween(fromMs, toMs) {
  try {
    if (!fs.existsSync(EXPENSES)) return null;
    const rows = JSON.parse(fs.readFileSync(EXPENSES, 'utf8').replace(/^﻿/, ''));
    if (!Array.isArray(rows)) return null;
    const inWindow = rows.filter((r) => {
      const t = parseLocalDate(r.date);
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
  weeklyGuardOrExit('finance-report');

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

  // This is the money view: every payment in the Stripe account (all products, any checkout), which
  // can differ from the product-only sale count in the weekly digest — say so plainly.
  const lines = ['📊 Your week in numbers (all payments in your Stripe account)', ''];
  const mixed = (thisWeek.currencies || []).length > 1;
  lines.push(`Revenue: ${money(thisWeek.gross, cur)}${mixed ? ' (mixed currencies)' : ''}${lastWeek.ok ? trend(thisWeek.gross, lastWeek.gross) : ''}`);
  if (mixed) lines.push(`(Payments came in ${thisWeek.currencies.map((c) => c.toUpperCase()).join(' + ')}; the totals add the amounts as-is, labeled in ${cur.toUpperCase()}.)`);
  lines.push(`Payments: ${thisWeek.count}`);
  if (thisWeek.count) lines.push(`Average payment: ${money(Math.round(thisWeek.gross / thisWeek.count), cur)}`);

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
  markRan('finance-report');
}

module.exports = { run, expensesBetween, parseLocalDate };

if (require.main === module) {
  run().catch((err) => console.log(`Finance report hit an error (will retry next week): ${err.message}`));
}
