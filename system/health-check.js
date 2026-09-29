// "Is it working?" — a one-shot health check for the automated business.
// Runs even before `npm install` (every check is guarded), so it can tell the user what still
// needs setting up. Reports in plain English; the assistant reads this and explains it warmly.
//
//   node system/health-check.js            → print the report
//   node system/health-check.js --notify   → also text the report to the seller (Telegram)
//
// It NEVER changes anything — purely read-only diagnosis. (It sends nothing to customers and
// no test messages; "connected" means the service accepted the key on a read-only call.)

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadEnv, sendTelegram } = require('./lib/telegram');
const { stripeGet } = require('./lib/stripe');
const { emailConfigured } = require('./lib/email');
const { loadWorkingHours, workingHoursProblem, isWithinWorkingHours, isScheduledRun, ranRecently, markRan, ON_WORDS } = require('./lib/working-hours');
const { productFileStatus } = require('./lib/config');
let sched = { installMoved: () => false, readManifest: () => ({ jobs: [] }), protectedFolderWarning: () => null, LOG_DIR: path.join(__dirname, 'logs') };
try { sched = require('./schedule-automation'); } catch (_) {}

function depInstalled(name) {
  try { require.resolve(name); return true; } catch (_) { return false; }
}

function getJson(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}

// macOS only: names of our launchd jobs that Login Items has switched off. Two signals, because the
// Login Items switch lives in Background Task Management, not in launchd's own disabled overrides:
//   1. `launchctl print-disabled gui/<uid>` lists overrides as `"com.aifreedommachine.<job>" => true`
//   2. a job whose plist is in ~/Library/LaunchAgents but that `launchctl print gui/<uid>/<label>`
//      can't find ("Could not find service", non-zero exit) is registered on disk yet not loaded —
//      exactly what the Login Items switch does. print-disabled still says "enabled" in that case.
// Never throws; [] elsewhere or on any error. Sudo-free.
function disabledMacJobs(jobNames = []) {
  if (process.platform !== 'darwin') return [];
  const { execFileSync } = require('child_process');
  const uid = process.getuid ? process.getuid() : '';
  const off = new Set();
  try {
    const out = String(execFileSync('launchctl', ['print-disabled', `gui/${uid}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }));
    for (const m of out.matchAll(/"com\.aifreedommachine\.([^"]+)"\s*=>\s*(true|disabled)/g)) off.add(m[1]);
  } catch (_) { /* fall through to the per-job probe */ }
  const os = require('os');
  for (const name of jobNames) {
    if (off.has(name)) continue;
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `com.aifreedommachine.${name}.plist`);
    if (!fs.existsSync(plist)) continue; // never registered here (or removed) — not a Login Items problem
    try { execFileSync('launchctl', ['print', `gui/${uid}/com.aifreedommachine.${name}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }); }
    catch (_) { off.add(name); }
  }
  return [...off];
}

// The Login Items entry is named from node's code-signing certificate, never from this product.
const LOGIN_ITEMS_FIX = 'open System Settings › General › Login Items & Extensions (called just Login Items on macOS 13 and 14), find the item named Node.js Foundation (it may show as node or Unknown Developer) under Allow in the Background, and turn it back on — that one switch controls all your automations (and anything else on your Mac that runs through Node.js).';

// Single-quote a path for the Mac shell, so a command the assistant copies from this report works
// for an install path with spaces ("AI Freedom Machine - Auto-Pilot") or a name like O'Brien:
// every ' inside becomes ''' (close the quote, a literal ', reopen).
const shQuote = (p) => `'${String(p).replace(/'/g, "'\\''")}'`;

// The bundled ffmpeg binary must actually start: on Apple Silicon an unsigned arm64 binary is
// SIGKILLed the moment it runs, and reels then never render. Returns a problem string, or null.
// The codesign fix only helps that one case (killed on an Apple Silicon Mac); any other failure —
// a half-finished download, the wrong build for this computer — is fixed by reinstalling the tools.
function ffmpegProblem() {
  let bin;
  try { bin = require('@ffmpeg-installer/ffmpeg').path; } catch (_) { return null; } // not installed yet: the "engine installed" line covers it
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(bin, ['-version'], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!r.error && r.status === 0) return null;
    const signingBlock = process.platform === 'darwin' && process.arch === 'arm64' && r.signal === 'SIGKILL';
    return `The video engine can't start on this computer — ask your assistant to fix it (reels won't render until then).${signingBlock ? ` fix: codesign --force --sign - ${shQuote(bin)}` : ' fix: reinstall the tools — run "npm install" in the system folder'}`;
  } catch (_) { return null; }
}

// Problems with how the jobs are registered with the computer's own scheduler, as [label, detail]
// pairs (all ⚠️). Read-only; each one is fixed by re-registering ("check my automations").
//   Windows: a task whose start time is saved in UTC drifts an hour at each daylight-saving change.
//   Mac:     a job that starts a node that isn't there any more (a Homebrew upgrade removed it), and
//            cron lines left by an old version of this tool (they run alongside the launchd jobs).
function schedulerProblems(jobs, { platform = process.platform } = {}) {
  const out = [];
  if (!jobs.length) return out;
  try {
    if (platform === 'win32' && sched.zonedWindowsTasks) {
      const zoned = sched.zonedWindowsTasks(sched.readManifest());
      if (zoned.length) out.push(['Automation times', `your automations need a quick refresh — say 'check my automations' (${zoned.length === 1 ? 'one job has' : `${zoned.length} jobs have`} a start time that shifts an hour when the clocks change). fix: node system/schedule-automation.js reregister`]);
    }
    if (platform === 'darwin' && sched.plistPath && sched.readPlistInfo) {
      const gone = [];
      for (const j of jobs) {
        const p = sched.plistPath(j.name);
        if (!fs.existsSync(p)) continue;
        const node = sched.readPlistInfo(p).node;
        if (node && !fs.existsSync(node)) gone.push({ name: j.name, node });
      }
      if (gone.length) out.push(['Automations can\'t start', `${gone.map((g) => g.name).join(', ')} ${gone.length === 1 ? 'points' : 'point'} at a Node.js that isn't on this Mac any more (${gone[0].node} — often after a Homebrew upgrade). Say 'check my automations' so I can re-register them. fix: node system/schedule-automation.js reregister`]);
    }
    if (platform === 'darwin' && sched.readCrontab && sched.oldCronBlocks) {
      const blocks = sched.oldCronBlocks(sched.readCrontab());
      if (blocks.length) out.push(['Old-style schedule', `old-style schedule found (${blocks.map((b) => b.name).join(', ')}) — say 'check my automations' to switch it over. fix: node system/schedule-automation.js reregister`]);
    }
  } catch (_) { /* a check that can't run must never break the report */ }
  return out;
}

function ago(ms) {
  const h = (Date.now() - ms) / 36e5;
  if (h < 1) return 'less than an hour ago';
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ok === true → ✅ working · ok === false → ⚠️ needs attention · ok === null → ⬜ not set up yet (often optional)
async function check() {
  const env = loadEnv();
  const lines = [];
  const mark = (ok, label, detail) =>
    lines.push(`${ok === true ? '✅' : ok === false ? '⚠️' : '⬜'} ${label}${detail ? ' — ' + detail : ''}`);

  // 0) Node version (fetch, FormData need 18+)
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) mark(false, 'Node.js', `version ${process.versions.node} is too old — install the current LTS from nodejs.org`);

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
    if (r.ok) mark(true, 'Payments (Stripe)', `connected${String(env.STRIPE_SECRET_KEY).startsWith('sk_test') || String(env.STRIPE_SECRET_KEY).startsWith('rk_test') ? ' — TEST mode (switch to live keys to take real money)' : ''}`);
    else mark(false, 'Payments (Stripe)', `key is set but Stripe rejected it (status ${r.status}) — re-check the key`);
  }

  // 3) Product delivery (email + something to deliver)
  // Same rule as delivery itself (lib/config productFileStatus): a link, or exactly one PDF.
  const pf = env.PRODUCT_DOWNLOAD_URL ? { file: null } : productFileStatus();
  const product = env.PRODUCT_DOWNLOAD_URL || pf.file;
  if (!emailConfigured(env)) mark(null, 'Product delivery (email)', 'not connected yet');
  else if (!nodemailer) mark(false, 'Product delivery (email)', 'connected, but the email engine isn\'t installed — run npm install');
  else if (!product) mark(false, 'Product delivery (email)', `email is ready, but buyers would get nothing: ${pf.message}`);
  else if (pf.file && fs.statSync(pf.file).size > 18 * 1048576) mark(false, 'Product delivery (email)', `${path.basename(pf.file)} is too big to email reliably — put it on Google Drive/Dropbox and set a download link instead`);
  else mark(true, 'Product delivery (email)', env.PRODUCT_DOWNLOAD_URL ? 'ready (sends your download link)' : `ready (attaches ${path.basename(product)})`);

  // 4) Phone alerts (Telegram) — optional. getMe is read-only: proves the token without messaging.
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) mark(null, 'Phone alerts (Telegram)', 'not connected yet (optional)');
  else {
    const r = await getJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    mark(r.status === 200, 'Phone alerts (Telegram)', r.status === 200 ? 'connected' : 'the bot token was rejected — re-check it');
  }

  // 5) Social posting — optional, safety state matters
  const social = env.META_PAGE_ID && env.META_PAGE_TOKEN;
  if (!social) mark(null, 'Social posting (Facebook/Instagram)', 'not connected yet (optional)');
  else {
    let V = 'v24.0'; try { V = require('./lib/meta').VERSION; } catch (_) {}
    const r = await getJson(`https://graph.facebook.com/${V}/${env.META_PAGE_ID}?fields=name&access_token=${encodeURIComponent(env.META_PAGE_TOKEN)}`);
    const live = String(env.SOCIAL_DRY_RUN || 'true').toLowerCase() === 'false';
    if (r.status !== 200) mark(false, 'Social posting (Facebook/Instagram)', 'the Page token was rejected or has expired — reconnect it on the connect page (ask your assistant to open the connect page)');
    else mark(true, 'Social posting (Facebook/Instagram)', `${r.json && r.json.name ? r.json.name + ' — ' : ''}${live ? 'LIVE — posts go public' : 'preview only (DRY-RUN, safe)'}`);
    if (env.IG_USER_ID && !env.IMGBB_API_KEY) mark(false, 'Instagram image hosting', 'Instagram posting needs IMGBB_API_KEY (free at imgbb.com)');
  }

  // 6) Unattended AI writing — optional. GET /v1/models is free and proves the key.
  if (!env.ANTHROPIC_API_KEY) mark(null, 'Unattended AI writing', 'optional — writing on request works without it');
  else {
    const r = await getJson('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
    mark(r.status === 200, 'Unattended AI writing', r.status === 200 ? 'ready' : `the Anthropic key was rejected (status ${r.status}) — check it, and that the account has credit`);
  }

  // 7) Meta ads — optional
  if (!env.META_AD_ACCOUNT_ID || !(env.META_ADS_TOKEN || env.META_PAGE_TOKEN)) mark(null, 'Meta ads', 'not connected yet (optional)');
  else {
    let V = 'v24.0'; try { V = require('./lib/meta').VERSION; } catch (_) {}
    const acct = env.META_AD_ACCOUNT_ID.startsWith('act_') ? env.META_AD_ACCOUNT_ID : `act_${env.META_AD_ACCOUNT_ID}`;
    const r = await getJson(`https://graph.facebook.com/${V}/${acct}?fields=account_status&access_token=${encodeURIComponent(env.META_ADS_TOKEN || env.META_PAGE_TOKEN)}`);
    if (r.status !== 200) mark(false, 'Meta ads', 'the ads token was rejected or lacks access to this ad account');
    else mark(r.json && r.json.account_status === 1, 'Meta ads', r.json && r.json.account_status === 1 ? 'connected (everything I create stays PAUSED until you switch it on)' : 'connected, but the ad account isn\'t active — check Ads Manager');
  }

  // 8) CRM (GoHighLevel) — optional, read-only test
  try {
    const ghl = require('./lib/ghl');
    if (!ghl.isConfigured(env)) mark(null, 'CRM hand-off (GoHighLevel)', 'not connected (optional)');
    else { const t = await ghl.testConnection(env); mark(t.ok, 'CRM hand-off (GoHighLevel)', t.ok ? 'connected' : `not working — ${t.reason}`); }
  } catch (_) {}

  // 9) Support inbox — optional
  try {
    const inbox = require('./lib/inbox');
    if (!inbox.isConfigured(env)) mark(null, 'Support inbox', 'not connected (optional)');
    else if (!depInstalled('imapflow')) mark(false, 'Support inbox', 'connected, but the inbox reader isn\'t installed — run "npm install" in the system folder');
    else mark(true, 'Support inbox', 'set up (I read it only when you ask, and never send without your OK)');
  } catch (_) {}

  // 10) Scheduled automations — from the job manifest, with the last run from each job's log.
  const m = sched.readManifest();
  const jobs = (m && m.jobs) || [];
  if (!jobs.length) mark(null, 'Automations scheduled', 'none yet — ask your assistant to turn on your automations (Automation System, #12)');
  else {
    const stale = [];
    // A job is only expected to run on working days, so the allowed gap has to cover the longest
    // run of days off (Mon–Thu hours = a 3-day weekend): otherwise every Monday morning the sale
    // watcher was reported as "hasn't run when expected" although nothing was wrong.
    let offRun = 0;
    try {
      const wd = loadWorkingHours().days; const { DAY_CODES } = require('./lib/working-hours');
      let run = 0; for (const d of [...DAY_CODES, ...DAY_CODES]) { run = wd.includes(d) ? 0 : run + 1; offRun = Math.max(offRun, Math.min(run, 6)); }
    } catch (_) {}
    const parts = jobs.map((j) => {
      const log = path.join(sched.LOG_DIR, `${j.name}.log`);
      if (!fs.existsSync(log)) return `${j.name} (hasn't run yet)`;
      const t = fs.statSync(log).mtimeMs;
      const maxGapH = j.freq === 'weekly' ? 24 * 9 : Math.max(j.freq === 'hourly' ? 72 : 24 * 4, 24 * (offRun + 2));
      if ((Date.now() - t) / 36e5 > maxGapH) stale.push(j.name);
      return `${j.name} (last ran ${ago(t)})`;
    });
    mark(stale.length ? false : true, 'Automations scheduled', `${jobs.length} job(s): ${parts.join(', ')}${stale.length ? ` — ${stale.join(', ')} hasn't run when expected; is the computer ${ON_WORDS} during your working hours?` : ''}`);
    const old = ['content-write', 'content-render', 'content-reels', 'render-content', 'render-reels', 'auto-content']
      .filter((n) => jobs.some((j) => j.name === n || j.script === `${n}.js`));
    if (old.length >= 2) mark(false, 'Content schedule', 'your weekly content is set up as separate jobs that start at the same time — ask me to "switch to the one-step weekly content job" so they run in order');
  }
  // macOS "Background Items Added": a buyer who flips our item off in Login Items silently kills every job.
  const offMac = disabledMacJobs(jobs.map((j) => j.name));
  if (jobs.length && offMac.length >= jobs.length) mark(false, 'Automations on this Mac', `all your automations are switched off in Login Items — ${LOGIN_ITEMS_FIX}`);
  else for (const name of offMac) mark(false, `Automation "${name}"`, `your Mac's Login Items switched this automation off — ${LOGIN_ITEMS_FIX}`);
  // Mac: jobs of ours still registered with launchd but no longer on the list keep firing unseen.
  let orphans = [];
  try { orphans = sched.orphanMacJobs ? sched.orphanMacJobs(m) : []; } catch (_) {}
  // Ours to clear (this folder / the one it moved from) vs. a job whose folder is simply gone but was
  // never this business's — reregister leaves those alone, so they get their own line and fix.
  const clearable = orphans.filter((o) => o.removable !== false);
  const strangers = orphans.filter((o) => o.removable === false);
  if (clearable.length) mark(false, 'Old automations', `${clearable.map((o) => o.name).join(', ')} ${clearable.length === 1 ? 'is' : 'are'} still set to run on this Mac but no longer in your list — ask your assistant to run "reregister" to clear ${clearable.length === 1 ? 'it' : 'them'} out`);
  if (strangers.length) mark(false, 'Unknown automations', `${strangers.map((o) => o.name).join(', ')} ${strangers.length === 1 ? 'runs' : 'run'} from a folder that isn't there right now (${strangers[0].workingDir}) — if that's an old copy you don't use (not a drive that's just unplugged), ask your assistant to remove ${strangers.length === 1 ? 'it' : 'them'} ("remove --name ${strangers[0].name}")`);
  const folderWarn = sched.protectedFolderWarning();
  if (folderWarn) mark(false, 'Business folder location', folderWarn);
  for (const [label, detail] of schedulerProblems(jobs)) mark(false, label, detail);
  const ff = ffmpegProblem();
  if (ff) mark(false, 'Video engine', ff);

  // 11) Sales caught up? (paid sales the loop hasn't delivered yet — same rules as the sale watcher)
  if (env.STRIPE_SECRET_KEY) {
    try {
      const { findNewSales } = require('./check-sales');
      const r = await findNewSales({ env, persist: false });
      // chargesFailed: Stripe didn't answer for payments made outside Stripe Checkout (only asked
      // when SALES_INCLUDE_OTHER_PAYMENTS=true), so "all caught up" can't honestly be said.
      const stuck = require('./lib/undelivered').list();
      if (stuck.length) mark(false, 'Sales delivered', `${stuck.length} paid sale(s) could NOT be emailed (${stuck[stuck.length - 1].reason || 'email failed'}) — say "a buyer didn't get their product" and I'll sort it now (the sale watcher also retries each run)`);
      else if (r.ok && r.sales.length) mark(false, 'Sales delivered', `${r.sales.length} paid sale(s) not delivered yet — your assistant can run the sale check now${r.chargesFailed ? ' (and I couldn\'t check payments made outside Stripe Checkout this time)' : ''}`);
      else if (r.ok && r.chargesFailed) mark(false, 'Sales delivered', 'Checkout sales are all caught up, but I couldn\'t check payments made outside Stripe Checkout this time — the sale watcher tries again on its next run');
      else if (r.ok) mark(true, 'Sales delivered', 'all caught up');
    } catch (_) {}
  }

  // 12) Folder-move detection — moving the business folder silently breaks scheduled jobs.
  if (sched.installMoved()) mark(false, 'Business folder', 'it looks like this folder moved — your assistant can fix your schedules by running "reregister"');

  // 13) Working-hours summary (context, not pass/fail)
  const wh = loadWorkingHours();
  // A missing/broken working-hours.json no longer crashes anything (the defaults are used), but the
  // owner's real hours are then unknown — worth fixing, so it shows as a line to act on.
  const whProblem = workingHoursProblem();
  if (whProblem) mark(false, 'Working hours', whProblem);
  lines.push(`🕒 Working hours: ${wh.days.join(', ')} ${wh.start}–${wh.end}. Jobs only run while your computer is ${ON_WORDS} during this window — right now is ${isWithinWorkingHours() ? 'INSIDE' : 'outside'} your hours.`);

  return lines;
}

async function run({ notify = false } = {}) {
  // The scheduled weekly text is registered on several days so a missed one catches up; once it
  // has gone out this week the other days stay quiet. On-request checks always run.
  if (notify && isScheduledRun() && ranRecently('health-check-notify')) {
    const msg = '[health-check] The weekly report already went out in the last 5 days — skipping this catch-up run. (This is normal and safe.)';
    console.log(msg);
    return msg;
  }
  let lines;
  try { lines = await check(); }
  catch (e) { lines = [`⚠️ The check itself hit a snag: ${e.message}`]; }
  const anyNeedsAttention = lines.some((l) => l.startsWith('⚠️'));
  const essentialsMissing = lines.some((l) => /^⬜ (Payments|Product delivery)/.test(l));
  const header = anyNeedsAttention
    ? 'Here\'s your setup — a couple of things need attention:'
    : essentialsMissing
      ? 'Here\'s your setup — nothing is broken; a few things just aren\'t connected yet:'
      : 'Here\'s your setup — everything essential looks good:';
  const report = [header, '', ...lines].join('\n');
  console.log(report);
  if (notify) { const sent = await sendTelegram(report).catch(() => false); if (sent) markRan('health-check-notify'); }
  return report;
}

module.exports = { run, check, ffmpegProblem, schedulerProblems };

if (require.main === module) {
  run({ notify: process.argv.includes('--notify') }).catch((e) => console.log('Health check error: ' + e.message));
}
