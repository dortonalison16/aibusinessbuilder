// "Is it working?" — a one-shot health check for the automated business.
// Runs even before `npm install` (every check is guarded), so it can tell the user what still
// needs setting up. Reports in plain English; the assistant reads this and explains it warmly.
//
//   node system/health-check.js            → print the report
//   node system/health-check.js --notify   → also text the report to the seller (Telegram)
//
// It NEVER changes anything — purely read-only diagnosis.

const fs = require('fs');
const path = require('path');
const { loadEnv, sendTelegram } = require('./lib/telegram');
const { stripeGet } = require('./lib/stripe');
const { emailConfigured } = require('./lib/email');
const { readSet } = require('./lib/store');
const { loadWorkingHours, isWithinWorkingHours } = require('./lib/working-hours');
let installMoved = () => false;
try { ({ installMoved } = require('./schedule-automation')); } catch (_) {}

function depInstalled(name) {
  try { require.resolve(name); return true; } catch (_) { return false; }
}

// ok === true → ✅ working · ok === false → ⚠️ needs attention · ok === null → ⬜ not set up yet (often optional)
async function check() {
  const env = loadEnv();
  const lines = [];
  const mark = (ok, label, detail) =>
    lines.push(`${ok === true ? '✅' : ok === false ? '⚠️' : '⬜'} ${label}${detail ? ' — ' + detail : ''}`);

  // 1) Tools installed (the one-time npm install)
  const nodemailer = depInstalled('nodemailer');
  const puppeteer = depInstalled('puppeteer') || fs.existsSync(path.join(__dirname, 'node_modules', 'puppeteer'));
  mark(nodemailer, 'Email engine installed', nodemailer ? null : 'run "npm install" in the system folder');
  mark(puppeteer, 'Content/render engine installed', puppeteer ? null : 'run "npm install" in the system folder');

  // 2) Payments (Stripe)
  if (!env.STRIPE_SECRET_KEY) {
    mark(null, 'Payments (Stripe)', 'not connected yet');
  } else {
    const r = await stripeGet('/v1/checkout/sessions?limit=1', env);
    if (r.ok) mark(true, 'Payments (Stripe)', `connected${String(env.STRIPE_SECRET_KEY).startsWith('sk_test') ? ' — TEST mode (switch to live keys to take real money)' : ''}`);
    else mark(false, 'Payments (Stripe)', `key is set but Stripe rejected it (status ${r.status}) — re-check the key`);
  }

  // 3) Product delivery (email)
  if (!emailConfigured(env)) mark(null, 'Product delivery (email)', 'not connected yet');
  else mark(nodemailer, 'Product delivery (email)', nodemailer ? 'ready' : 'connected, but the email engine isn\'t installed — run npm install');

  // 4) Phone alerts (Telegram) — optional
  mark(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? true : null, 'Phone alerts (Telegram)',
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? 'connected' : 'not connected yet (optional)');

  // 5) Social posting — optional, safety state matters
  const social = env.META_PAGE_ID && env.META_PAGE_TOKEN;
  mark(social ? true : null, 'Social posting (Facebook/Instagram)',
    social ? (String(env.SOCIAL_DRY_RUN || 'true').toLowerCase() === 'false' ? 'LIVE — posts go public' : 'preview only (DRY-RUN, safe)') : 'not connected yet (optional)');

  // 6) Unattended AI writing — optional
  mark(env.ANTHROPIC_API_KEY ? true : null, 'Unattended AI writing',
    env.ANTHROPIC_API_KEY ? 'ready' : 'optional — writing on request works without it');

  // 7) Scheduled automations (best-effort; Windows registers wrapper files)
  if (process.platform === 'win32') {
    const wrapperDir = path.join(__dirname, 'wrappers');
    const wrappers = fs.existsSync(wrapperDir) ? fs.readdirSync(wrapperDir).filter((f) => !f.startsWith('.')) : [];
    mark(wrappers.length ? true : null, 'Automations scheduled', wrappers.length ? `${wrappers.length} job(s) set up` : 'none yet (set these up in the connections step)');
  }

  // 8) Sales caught up? (paid Stripe sessions the loop hasn't delivered yet)
  if (env.STRIPE_SECRET_KEY) {
    const r = await stripeGet('/v1/checkout/sessions?limit=100', env);
    if (r.ok) {
      const paid = ((r.data && r.data.data) || []).filter((s) => s.payment_status === 'paid');
      const seen = readSet('seen-sales');
      const unhandled = paid.filter((s) => !seen.has(s.id));
      mark(unhandled.length === 0, 'Sales delivered',
        unhandled.length === 0 ? 'all caught up' : `${unhandled.length} paid sale(s) not delivered yet — your assistant can run the sale check now`);
    }
  }

  // 8b) Folder-move detection — moving the business folder silently breaks scheduled jobs.
  if (installMoved()) mark(false, 'Business folder', 'it looks like this folder moved — your assistant can fix your schedules by running "reregister"');

  // 9) Working-hours summary (context, not pass/fail)
  const wh = loadWorkingHours();
  lines.push(`🕒 Working hours: ${wh.days.join(', ')} ${wh.start}–${wh.end}. Jobs only run while your computer is on during this window — right now is ${isWithinWorkingHours() ? 'INSIDE' : 'outside'} your hours.`);

  return lines;
}

async function run({ notify = false } = {}) {
  let lines;
  try { lines = await check(); }
  catch (e) { lines = [`⚠️ The check itself hit a snag: ${e.message}`]; }
  const anyNeedsAttention = lines.some((l) => l.startsWith('⚠️'));
  const header = anyNeedsAttention
    ? 'Here\'s your setup — a couple of things need attention:'
    : 'Here\'s your setup — everything essential looks good:';
  const report = [header, '', ...lines].join('\n');
  console.log(report);
  if (notify) await sendTelegram(report).catch(() => {});
  return report;
}

module.exports = { run, check };

if (require.main === module) {
  run({ notify: process.argv.includes('--notify') }).catch((e) => console.log('Health check error: ' + e.message));
}
