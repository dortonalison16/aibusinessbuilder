// The automated business loop. Runs on a schedule (inside working hours):
//   1. Ask Stripe for recent PAID checkouts (since the watcher was switched on)
//   2. For each NEW one: email the buyer their product + ping the seller on Telegram
//   3. Remember it so it's never handled twice
//
// Why polling (not webhooks): webhooks need a public server URL, which a non-technical person
// running this on their own laptop doesn't have. Polling every working-hour is reliable and
// needs zero hosting.
//
// SAFETY — the start line: the first time this runs it records "now" and only ever handles sales
// made AFTER that moment. Without it, switching the watcher on for a Stripe account with history
// would email this product to every past buyer (of anything) in one go. To deliver an older sale
// on purpose:  node check-sales.js --since 2026-09-01
// To check right now, even outside working hours (the owner asked):  node check-sales.js --now
//
// Optional filters (.env):
//   STRIPE_PRODUCT_IDS=prod_A,prod_B   only handle checkouts that contain one of these products
//   SALES_INCLUDE_OTHER_PAYMENTS=true  also catch payments that aren't Stripe Checkout (e.g. a
//                                      GoHighLevel order form). Only for accounts that sell just
//                                      this product — those payments carry no product info.

const fs = require('fs');
const path = require('path');
const { guardOrExit } = require('./lib/working-hours');
const { stripeGet, money } = require('./lib/stripe');
const { sendTelegram, loadEnv } = require('./lib/telegram');
const { readSet, writeSet } = require('./lib/store');
const { deliverProduct } = require('./deliver-product');
const { getConfigValue } = require('./lib/config');
const ghl = require('./lib/ghl');
const undelivered = require('./lib/undelivered');

const START_FILE = path.join(__dirname, '.state', 'sale-watch-start.json');

// Tag-safe slug for the CRM tag (lowercase, hyphens, no punctuation).
const slug = (s) => String(s || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// "--since 2026-09-28" means that day from midnight ON THE OWNER'S CLOCK. new Date('2026-09-28')
// is UTC midnight, which in Australia is 10am local — a test purchase made that morning was invisible
// to "--since <today>". Returns unix seconds, or null if it isn't a date.
function parseSince(since) {
  const m = String(since || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const t = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : new Date(since).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// The moment (unix seconds) sales start counting from. Created on first run.
function startLine({ since } = {}) {
  if (since) {
    const t = parseSince(since);
    // A backfill run on a brand-new install (setup's test purchase) must still lay the start line
    // at "now" — otherwise the next scheduled run sees a non-empty seen-sales list, assumes an old
    // install, and looks back 30 days, emailing every recent buyer.
    if (t !== null) return { sec: t, fresh: false, saveNow: !fs.existsSync(START_FILE) };
  }
  try {
    const s = JSON.parse(fs.readFileSync(START_FILE, 'utf8').replace(/^﻿/, ''));
    if (Number.isFinite(s.sinceSec)) return { sec: s.sinceSec, fresh: false };
  } catch (_) { /* first run */ }
  // An install that was already running before this safety existed has a seen-sales list — every
  // older sale is already in it, so look back 30 days to catch anything since the last run.
  const alreadyRunning = readSet('seen-sales').size > 0;
  const sec = Math.floor(Date.now() / 1000) - (alreadyRunning ? 30 * 86400 : 0);
  return { sec, fresh: !alreadyRunning, save: true };
}

function saveStartLine(sec) {
  const dir = path.dirname(START_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(START_FILE, JSON.stringify({ sinceSec: sec, since: new Date(sec * 1000).toISOString() }, null, 2));
}

// ── keeping the hourly query small ───────────────────────────────────────────────────────────────
// The start line used to stay at install day forever, so every hourly run paged through every sale
// ever made (10 Stripe calls an hour after ~1,000 sales) and seen-sales grew without end. After a
// CLEAN run (Stripe answered, nothing left half-handled) the line moves up to 30 days ago — never
// past a sale that still needs attention — and ids for sales older than the line minus a 15-day
// margin (so, anything created within ~45 days is kept) move out of seen-sales into an archive.
// The archive is only read on a `--since` backfill, so nobody is ever emailed twice: an old id
// leaves the hourly list, not the memory. seen-sales-created.json remembers when each seen sale
// was made (an id from before this existed is stamped with the time it was first noticed, which
// only ever keeps it LONGER).
const LOOKBACK_SEC = 30 * 86400;
const TRIM_MARGIN_SEC = 15 * 86400;
const SEEN_AT_FILE = path.join(__dirname, '.state', 'seen-sales-created.json');
function readSeenAt() {
  try { const m = JSON.parse(fs.readFileSync(SEEN_AT_FILE, 'utf8').replace(/^﻿/, '')); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; }
  catch (_) { return {}; }
}
function writeSeenAt(map) {
  fs.mkdirSync(path.dirname(SEEN_AT_FILE), { recursive: true });
  const tmp = SEEN_AT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map));
  fs.renameSync(tmp, SEEN_AT_FILE);
}
function noteSeenAt(entries) { // [{ id, created }]
  if (!entries.length) return;
  const map = readSeenAt();
  for (const e of entries) if (e && e.id && Number.isFinite(e.created)) map[e.id] = e.created;
  writeSeenAt(map);
}

// Move the start line up and thin the seen list. `pendingSec` = the created time of the oldest sale
// this run could not finish (a delivery that failed, a product check Stripe didn't answer); the
// line never passes the day before it. Returns the new line (unchanged if it didn't move).
function advanceStartLine({ startSec, nowSec = Math.floor(Date.now() / 1000), pendingSec = null } = {}) {
  let target = nowSec - LOOKBACK_SEC;
  if (Number.isFinite(pendingSec)) target = Math.min(target, pendingSec - 86400);
  const next = Math.max(startSec, target);
  if (next > startSec) saveStartLine(next);

  const seen = readSet('seen-sales');
  if (!seen.size) return next;
  const at = readSeenAt();
  const archive = readSet('seen-sales-archive');
  const cut = next - TRIM_MARGIN_SEC;
  let moved = 0;
  for (const id of seen) {
    if (!Number.isFinite(at[id])) { at[id] = nowSec; continue; } // never trimmed on the run it's first dated
    if (at[id] < cut) { seen.delete(id); delete at[id]; archive.add(id); moved++; }
  }
  if (moved) { writeSet('seen-sales-archive', archive); writeSet('seen-sales', seen); }
  writeSeenAt(at);
  return next;
}

// Page through a Stripe list endpoint created on/after `sinceSec`.
async function listSince(endpoint, sinceSec, env) {
  let items = [];
  let startingAfter = null;
  for (let page = 0; page < 10; page++) {
    const qs = `${endpoint}?limit=100&created[gte]=${sinceSec}${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
    const res = await stripeGet(qs, env);
    if (res.error === 'no-key') return { ok: false, noKey: true };
    if (!res.ok) return { ok: false, status: res.status };
    const batch = (res.data && res.data.data) || [];
    items = items.concat(batch);
    if (!(res.data && res.data.has_more) || batch.length === 0) break;
    startingAfter = batch[batch.length - 1].id;
  }
  return { ok: true, items };
}

// Does this checkout contain one of the seller's chosen products? (Only asked when a filter is set.)
async function sessionHasProduct(sessionId, productIds, env) {
  const res = await stripeGet(`/v1/checkout/sessions/${sessionId}/line_items?limit=100`, env);
  if (!res.ok) return null; // unknown — caller treats as "try again next run"
  return ((res.data && res.data.data) || []).some((li) => li.price && productIds.includes(li.price.product));
}

// THE definition of a sale, shared by the sale watcher, the health check and the weekly digest so
// they never disagree: every paid sale created since `sinceSec`, in one normalized shape
// { id, email, name, amount_total, currency, created }. Ids in `seen` are skipped; checkouts found
// to be for a different product (STRIPE_PRODUCT_IDS) are added to `seen` so they're asked about once.
async function listSales({ env: envIn, sinceSec, seen = new Set() } = {}) {
  const env = envIn || loadEnv();
  const productIds = String(env.STRIPE_PRODUCT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const sessions = await listSince('/v1/checkout/sessions', sinceSec, env);
  if (!sessions.ok) return { ok: false, noKey: sessions.noKey, status: sessions.status };

  const sales = [];
  const filteredOut = []; // { id, created } of other-product checkouts added to `seen`
  let unresolvedSec = null; // oldest paid checkout whose product check Stripe didn't answer
  const checkoutIntents = new Set();
  // Subscription-mode checkouts have no payment_intent (the charge hangs off an invoice), so they
  // are matched by invoice id, or — on API versions whose charges no longer carry `invoice` — by
  // buyer email + amount.
  const checkoutInvoices = new Set();
  const invoiceCheckouts = new Set();
  const idOf = (x) => (x && typeof x === 'object' ? x.id : x);
  for (const s of sessions.items) {
    if (s.payment_intent) checkoutIntents.add(idOf(s.payment_intent));
    if (s.invoice) checkoutInvoices.add(idOf(s.invoice));
    if (!s.payment_intent) invoiceCheckouts.add(`${String((s.customer_details || {}).email || '').toLowerCase()}|${s.amount_total}`);
    if (s.payment_status !== 'paid' || seen.has(s.id)) continue;
    if (productIds.length) {
      const has = await sessionHasProduct(s.id, productIds, env);
      if (has === false) { seen.add(s.id); filteredOut.push({ id: s.id, created: s.created }); continue; } // a different product — never this watcher's job
      if (has === null) { if (unresolvedSec === null || s.created < unresolvedSec) unresolvedSec = s.created; continue; }
    }
    const d = s.customer_details || {};
    sales.push({ id: s.id, email: d.email, name: d.name, amount_total: s.amount_total, currency: s.currency, created: s.created });
  }

  let chargesFailed = false;
  if (String(env.SALES_INCLUDE_OTHER_PAYMENTS || '').toLowerCase() === 'true') {
    const charges = await listSince('/v1/charges', sinceSec, env);
    if (!charges.ok) {
      // Stripe answered the checkouts but not the other payments. Any of those could be an
      // unhandled sale, so this run is NOT clean: holding "unresolved" at the start line keeps the
      // line where it is (advanceStartLine never passes it) and the next run asks again.
      chargesFailed = true;
      unresolvedSec = unresolvedSec === null ? sinceSec : Math.min(unresolvedSec, sinceSec);
    } else {
      for (const c of charges.items) {
        if (c.status !== 'succeeded' || c.refunded || seen.has(c.id)) continue;
        if (c.payment_intent && checkoutIntents.has(idOf(c.payment_intent))) continue; // already counted as a checkout
        if (c.invoice && checkoutInvoices.has(idOf(c.invoice))) continue;
        const b = c.billing_details || {};
        if (invoiceCheckouts.has(`${String(b.email || c.receipt_email || '').toLowerCase()}|${c.amount}`)) continue;
        sales.push({ id: c.id, email: b.email || c.receipt_email, name: b.name, amount_total: c.amount, currency: c.currency, created: c.created });
      }
    }
  }
  return { ok: true, sales, filtered: productIds.length > 0, filteredOut, unresolvedSec, chargesFailed };
}

// Every paid sale since the start line that hasn't been handled yet.
async function findNewSales({ env: envIn, since, persist = true } = {}) {
  const env = envIn || loadEnv();
  const start = startLine({ since });
  const seen = readSet('seen-sales');
  // A backfill reaches behind the start line, where handled ids have been moved to the archive —
  // read it too, so a `--since` from months back can never email a buyer a second time.
  const archived = since ? readSet('seen-sales-archive') : new Set();
  const r = await listSales({ env, sinceSec: start.sec, seen: archived.size ? new Set([...seen, ...archived]) : seen });
  if (!r.ok) return r;
  // Filtered-out sessions were added to `seen`; persist so they're never re-checked.
  if (r.filtered && persist && r.filteredOut.length) {
    for (const f of r.filteredOut) seen.add(f.id);
    writeSet('seen-sales', seen);
    noteSeenAt(r.filteredOut);
  }
  return { ok: true, sales: r.sales, start, unresolvedSec: r.unresolvedSec, chargesFailed: r.chargesFailed };
}

// One sale check at a time. The scheduler never overlaps its own runs, but an on-request run
// ("--now", "--since") can land while the hourly one is still delivering — both would read the
// seen-sales list before either wrote it, and a buyer could be emailed twice. A lock older than two
// hours is treated as left behind by a crash.
const LOCK_FILE = path.join(__dirname, '.state', 'sale-watch.lock');
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs; } catch (_) { continue; }
      if (age < 2 * 3600e3) return false;
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    }
  }
  return false;
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} }

async function run({ since, now = false } = {}) {
  // Refuse to run outside the user's working hours (safe even if the OS fires us oddly).
  // "--now" is an on-request check (the owner asked), like meta-ads.js monitor --now.
  if (!since && !now) guardOrExit('sale-watch');
  if (since && parseSince(since) === null) {
    console.log(`--since needs a date like YYYY-MM-DD (got "${since}") — nothing was checked.`);
    process.exitCode = 1;
    return;
  }
  if (!acquireLock()) { console.log('Another sale check is still running — skipping this one so nobody is emailed twice.'); return; }
  try { await runLocked({ since }); } finally { releaseLock(); }
}

async function runLocked({ since }) {
  const env = loadEnv();

  const found = await findNewSales({ env, since });
  if (!found.ok) {
    if (found.noKey) console.log('Stripe not connected yet — nothing to check. (Add STRIPE_SECRET_KEY in .env.)');
    else if (found.status === 401 || found.status === 403) console.log(`Stripe rejected the key (status ${found.status}) — reconnect Stripe on the connect page. Nothing was sent.`);
    else console.log(`Could not reach Stripe (status ${found.status}). Will try again next run.`);
    return;
  }
  if (found.start.saveNow) saveStartLine(Math.floor(Date.now() / 1000));
  if (found.start.save) {
    saveStartLine(found.start.sec);
    if (found.start.fresh) {
      console.log('Sale watcher switched on. ✅ From now on, every new sale gets its product automatically.');
      console.log('(Sales made before today were left alone on purpose — nobody from the past gets emailed.)');
    }
  }

  const seen = readSet('seen-sales');
  const productName = getConfigValue('Name', 'your product');

  // Retry sales whose product email failed on an earlier run (a revoked app password, an
  // antivirus blocking mail…). Delivery only — the owner was already told about the sale, so the
  // only new message is the good news once it finally goes out.
  for (const u of undelivered.list()) {
    if (!u.email) continue; // no address on the order — only the owner can sort that out
    const r = await deliverProduct({ email: u.email, name: u.name }, env).catch((err) => ({ ok: false, message: err.message }));
    if (r.ok) {
      undelivered.removeEmail(u.email);
      console.log(`Delivered earlier sale to ${u.email} on retry.`);
      await sendTelegram(`✅ ${u.email} now has their product — the email that failed earlier went through.`, env);
    }
  }

  let handled = 0;
  let pendingSec = found.unresolvedSec; // oldest sale this run could not finish
  const notePending = (sec) => { if (Number.isFinite(sec) && (pendingSec === null || sec < pendingSec)) pendingSec = sec; };
  for (const s of found.sales) {
    if (seen.has(s.id)) continue;
    const amount = money(s.amount_total, s.currency);

    // Deliver the product (only if we have an email + delivery is configured).
    let deliveredOk = false;
    let deliveryNote = 'NOT sent — no email address on the order';
    if (s.email) {
      const r = await deliverProduct({ email: s.email, name: s.name }, env).catch((err) => ({ ok: false, message: err.message }));
      deliveredOk = Boolean(r.ok);
      deliveryNote = r.ok ? `emailed to ${s.email}` : `NOT sent — ${r.message || r.reason}`;
    }

    // Hand the buyer to their CRM so their own onboarding emails fire automatically. Entirely
    // optional — if GHL isn't configured this is a no-op and nothing downstream changes.
    let crmNote = null;
    if (s.email && ghl.isConfigured(env)) {
      const g = await ghl.addBuyer({ email: s.email, name: s.name, tags: ['customer', 'purchased-' + slug(productName)], env });
      crmNote = g.ok ? 'added to your CRM and tagged' : `CRM add FAILED — ${g.reason}`;
    }

    // Ping the seller — plain text. Report the whole chain, not just the sale: "you made a sale"
    // is exciting, but "sale made AND product delivered" is what lets them close the laptop. And
    // if a link broke, say so loudly — a silent delivery failure becomes an angry customer and a
    // refund that they'd otherwise find out about days later.
    const lines = [`💸 New sale! ${productName} — ${amount}`, `Buyer: ${s.email || 'unknown'}`];
    lines.push(`${deliveredOk ? '✅' : '⚠️'} Product ${deliveryNote}`);
    if (crmNote) lines.push(`${crmNote.includes('FAILED') ? '⚠️' : '✅'} ${crmNote}`);
    lines.push(deliveredOk
      ? 'Nothing needed from you.'
      : 'They have PAID and not received it yet — open your assistant and say "a buyer didn\'t get their product" and I\'ll sort it now.');
    await sendTelegram(lines.join('\n'), env);

    // Persist immediately after EACH sale — so a crash or the laptop sleeping mid-loop can never
    // cause this buyer to be emailed (and the seller pinged) twice on the next run.
    seen.add(s.id);
    writeSet('seen-sales', seen);
    noteSeenAt([{ id: s.id, created: s.created }]);
    if (!deliveredOk) {
      notePending(s.created);
      // Remembered so it's retried each run and the Health Check can't say "all caught up".
      undelivered.add({ id: s.id, email: s.email, name: s.name, created: s.created, reason: deliveryNote.replace(/^NOT sent — /, '') });
    }
    handled++;
    console.log(`Handled sale ${s.id}: ${amount} — ${deliveredOk ? 'delivered' : 'NOT delivered'}`);
  }

  // A scheduled run that finished cleanly moves the start line up (see advanceStartLine). A
  // backfill (--since) is a one-off look behind the line and leaves it alone.
  if (!since) advanceStartLine({ startSec: found.start.sec, pendingSec });

  if (found.chargesFailed) console.log('(Stripe didn\'t answer for payments made outside Stripe Checkout this run — those will be checked again next run.)');
  if (handled === 0) console.log('No new sales this run. ✅');
  else console.log(`Done — ${handled} new sale(s) handled. ✅`);
}

module.exports = { run, findNewSales, listSales, advanceStartLine };

if (require.main === module) {
  const i = process.argv.indexOf('--since');
  const since = i !== -1 ? process.argv[i + 1] : null;
  run({ since, now: process.argv.includes('--now') }).catch((err) => {
    console.log(`Sale check hit an error (will retry next run): ${err.message}`);
    process.exitCode = 1;
  });
}
