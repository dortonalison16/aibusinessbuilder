// Cross-platform scheduler — registers an automation to run on a schedule that
// stays INSIDE the user's working hours, so jobs actually fire (the computer is on).
//
// Windows : a CRLF .bat wrapper + a Task Scheduler task. Registered with "run on battery" and
//           "run as soon as possible after a missed start" ON — Task Scheduler's defaults skip
//           laptops on battery and never catch up a missed run.
// Mac     : a launchd agent (~/Library/LaunchAgents). Unlike cron, launchd runs a job that was
//           missed while the Mac slept as soon as it wakes.
// Linux   : a tagged crontab entry.
// Every run appends to system/logs/<name>.log, so the health check can see when each job last ran.
//
// Usage (the assistant runs these for the user). --script is a path relative to system/:
//   node schedule-automation.js add --name weekly-digest --script weekly-digest.js --freq weekly --day Mon
//   node schedule-automation.js add --name sale-watch    --script check-sales.js   --freq hourly
//   node schedule-automation.js add --name ads-monitor   --script meta-ads.js --args "monitor" --freq daily
//   node schedule-automation.js add --name content-week  --script weekly-content.js --freq weekly --day Mon --offset 15
//   node schedule-automation.js remove --name weekly-digest
//   node schedule-automation.js reregister   (folder-move self-heal: rebuild all saved jobs here)
//   node schedule-automation.js list
// --offset <minutes> staggers a job later in the working window. Add --dry-run to preview.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { loadWorkingHours, suggestedRunTime } = require('./lib/working-hours');

const SYSTEM_DIR = __dirname;
const WRAPPER_DIR = path.join(SYSTEM_DIR, 'wrappers');
const LOG_DIR = path.join(SYSTEM_DIR, 'logs');
const TASK_PREFIX = 'AIB_'; // so all our tasks are easy to find/remove
const CRON_TAG = '# >>> AI-Business-Builder';
const LAUNCHD_PREFIX = 'com.aifreedommachine.';
const DAY_NAMES = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };

// ── Job manifest (powers folder-move self-heal) ─────────────────────────────
// Every scheduled job is recorded here along with the path it was registered FROM. If the buyer
// later moves/renames their business folder, the OS tasks point at the old (now-missing) path and
// fail silently. `reregister` reads this manifest and rebuilds every job at the CURRENT path.
const MANIFEST = path.join(SYSTEM_DIR, '.state', 'scheduled-jobs.json');
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^﻿/, '')); } catch (_) { return { installPath: SYSTEM_DIR, jobs: [] }; }
}
function writeManifest(m) {
  const dir = path.dirname(MANIFEST);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = MANIFEST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, MANIFEST);
}
// When the jobs move to this folder from another one, the old folder is remembered: it is this
// business's own earlier copy (the one an upgrade was unzipped next to), so later "add"s may take
// over the jobs that still point there instead of refusing them as another business's.
function notePreviousPath(m) {
  const add = [m.installPath, ...approvedFolders].filter((p) => p && !sameFolder(p, SYSTEM_DIR));
  for (const p of add) m.previousPaths = [...(m.previousPaths || []).filter((q) => !sameFolder(q, p)), p].slice(-5);
}
function recordJob(job) {
  const m = readManifest();
  notePreviousPath(m);
  m.installPath = SYSTEM_DIR; // always reflect where jobs currently point
  m.jobs = (m.jobs || []).filter((j) => j.name !== job.name);
  m.jobs.push({ name: job.name, script: job.script, args: job.args || '', freq: job.freq || 'daily', day: job.day || null, offset: job.offset || 0 });
  writeManifest(m);
}
function forgetJob(name) {
  const m = readManifest();
  m.jobs = (m.jobs || []).filter((j) => j.name !== name);
  writeManifest(m);
}
// True if jobs were registered from a DIFFERENT folder than where we are now (i.e. the folder moved).
function installMoved() {
  const m = readManifest();
  return Boolean(m.installPath && m.jobs && m.jobs.length && !sameFolder(m.installPath, SYSTEM_DIR));
}

// macOS blocks background jobs from reading Desktop/Documents/Downloads (and iCloud Drive) unless
// the user grants Full Disk Access — jobs there fail silently. A folder on an external or network
// drive (/Volumes/…) is shaky too: nothing runs while the drive is unplugged or not connected, and
// macOS asks separately before a background job may read removable and network volumes.
// Returns a warning or null.
function protectedFolderWarning(dir = SYSTEM_DIR, { platform = os.platform(), home = os.homedir() } = {}) {
  if (platform !== 'darwin') return null;
  if (String(dir).startsWith('/Volumes/')) {
    const vol = String(dir).split('/').slice(0, 3).join('/');
    return `Your business folder is on an external or network drive (${vol}). Scheduled jobs can't run while that drive is unplugged or not connected, and macOS may block background jobs from reading it. Move the whole folder to your home folder (${home}) and run "reregister" so your automations run reliably.`;
  }
  const bad = ['Desktop', 'Documents', 'Downloads', path.join('Library', 'Mobile Documents')].map((d) => path.join(home, d));
  const hit = bad.find((b) => String(dir).startsWith(b + path.sep));
  if (!hit) return null;
  const label = path.basename(hit) === 'Mobile Documents' ? 'iCloud Drive' : path.basename(hit);
  return `Your business folder is inside ${label}, which macOS blocks background jobs from reading. Move the whole folder to your home folder (${home}) and run "reregister" — or scheduled jobs will fail silently.`;
}

// Weekly jobs are also registered on every following working day (same time): launchd only catches
// up a job the Mac slept through, not one it was off or logged out for, and Task Scheduler's
// catch-up needs the job to have been missed while Windows was up. The job itself skips the extra
// days once it has run this week (lib/working-hours weeklyGuardOrExit), so nothing runs twice.
// Only the next 2 days count. The guard treats a run in the last 5 days as "done this week", so a
// catch-up run must leave at least 5 days before the job's own day comes round again (7 - 2 = 5).
// A catch-up 3 or 4 days late used to make the next real run look like a duplicate, so the job
// quietly moved to the catch-up weekday for good — a "Thursday" job that ran every Monday.
function catchUpDays(days, cfg) {
  if (days.length !== 1) return days;
  const first = DAY_CODES.indexOf(days[0]);
  const out = [days[0]];
  for (let i = 1; i <= 2; i++) { const d = DAY_CODES[(first + i) % 7]; if (cfg.days.includes(d)) out.push(d); }
  return out;
}
const DAY_CODES = Object.keys(DAY_NAMES);

// ── One computer, one business folder ───────────────────────────────────────
// Every business folder uses the same job names (AIB_sale-watch, com.aifreedommachine.sale-watch).
// Setting up a second business folder on the same computer used to silently re-point the FIRST
// folder's jobs at the second one — its sales stopped being delivered and nobody was told. So before
// a job is overwritten we look at the folder it runs from now: if that's another business folder
// that still exists, we stop and say so. A folder that no longer exists (moved or renamed) is fine
// to take over — that's exactly what "reregister" is for.
// Same folder, whatever the spelling: the .native realpath gives the name as it is on disk (so a
// case-only difference on Windows/Mac, "c:\users" vs "C:\Users", isn't a different folder).
function sameFolder(a, b) {
  const norm = (p) => {
    let r = path.resolve(String(p));
    try { r = fs.realpathSync.native(r); } catch (_) { try { r = fs.realpathSync(r); } catch (__) {} }
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}
// Upgrades: the upgrade guide says to keep the old folder and unzip the new one elsewhere, and the
// old .state (with this manifest) is copied across. So a job pointing at the folder this manifest
// says it came from (installPath or an earlier one) is OUR OWN older copy — taken over, not refused.
function isOurEarlierFolder(folder, m = readManifest()) {
  return [m.installPath, ...(m.previousPaths || [])].filter(Boolean).some((p) => sameFolder(p, folder));
}
// But a DUPLICATED business folder (copied with its .state) looks exactly like an upgrade copy, and
// silently taking over would leave the original business with no automations. So the old folder
// must also be recognizably the same business: at least one identifier filled in on both sides and
// equal (business name in client-config.md, Facebook Page, Stripe key, sender email), and none
// filled in on both sides and different. Anything less needs the owner's own "yes, that's my old
// copy" — the assistant then runs the command again with --take-over.
function readEnvAt(root) {
  const out = {};
  try {
    for (const l of fs.readFileSync(path.join(root, '.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (_) {}
  return out;
}
function businessNameAt(root) {
  try {
    const lines = fs.readFileSync(path.join(root, 'client-config.md'), 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim().toLowerCase() === '## name');
    for (let j = i + 1; i > -1 && j < lines.length && !lines[j].trim().startsWith('## '); j++) {
      const l = lines[j].trim();
      if (l.startsWith('- ') && !/^-\s*\(.*\)\s*$/.test(l)) return l.slice(2).trim();
    }
  } catch (_) {}
  return '';
}
function identityOf(sysDir) {
  const root = path.dirname(sysDir);
  const env = readEnvAt(root);
  return { 'business name': businessNameAt(root).toLowerCase(), 'Facebook Page': env.META_PAGE_ID || '', 'Stripe account': env.STRIPE_SECRET_KEY || '', 'sender email': String(env.EMAIL_FROM || '').toLowerCase() };
}
function sameBusiness(otherSys) {
  const a = identityOf(SYSTEM_DIR); const b = identityOf(otherSys);
  let match = false;
  for (const k of Object.keys(a)) {
    if (!a[k] || !b[k]) continue;
    if (a[k] !== b[k]) return false;
    match = true;
  }
  return match;
}

// Folders whose jobs this run may take over (a verified upgrade copy, or one the owner confirmed).
const approvedFolders = [];
let takeOverConfirmed = false; // --take-over: the owner said "yes, that's my old copy"
function approve(folder, how) {
  if (approvedFolders.some((f) => sameFolder(f, folder))) return;
  approvedFolders.push(folder);
  console.log(how === 'confirmed'
    ? `Taking your automations over from ${folder}, as you confirmed that's your old copy — it won't run them any more.`
    : `Moved your automations over from your old folder (${folder}) to this one — the old copy won't run them any more.`);
}
// Throws when a job may NOT be pointed at this folder; returns quietly when it may.
function checkFolder(name, folder) {
  if (!folder || sameFolder(folder, SYSTEM_DIR)) return;
  // "Still exists" means a business folder is really there, not just an empty leftover directory.
  if (!fs.existsSync(path.join(folder, 'schedule-automation.js'))) return;
  if (approvedFolders.some((f) => sameFolder(f, folder))) return;
  // Run from the OLD copy after the jobs already moved to the newer one: nothing to do here.
  let theirs = null;
  try { theirs = JSON.parse(fs.readFileSync(path.join(folder, '.state', 'scheduled-jobs.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (_) {}
  if (theirs && theirs.installPath && sameFolder(theirs.installPath, folder) && (theirs.previousPaths || []).some((p) => sameFolder(p, SYSTEM_DIR))) {
    const e = new Error(`Your automations already moved to your newer folder (${folder}) — nothing is needed here. This older copy doesn't run them any more.`);
    e.code = 'MOVED_ON';
    throw e;
  }
  const earlier = isOurEarlierFolder(folder);
  if (takeOverConfirmed) return approve(folder, 'confirmed');
  if (earlier && sameBusiness(folder)) return approve(folder, 'upgrade');
  throw otherFolderError(name, folder, { earlier });
}
function otherLiveFolder(folder) { try { checkFolder('job', folder); return null; } catch (e) { return e.code === 'OTHER_FOLDER' ? folder : null; } }
function otherFolderError(name, folder, { earlier = false } = {}) {
  const e = new Error(earlier
    ? `"${name}" still runs from ${folder}. This folder's saved settings say it came from there, but I can't confirm it's the same business (the business name, Facebook Page, Stripe key and sender email don't match, or aren't filled in on both), so I haven't changed anything. If it IS your old copy, say "yes, that's my old copy" and I'll take your automations over. If it's a different business, one computer runs one business folder's automations — turn them off in that folder first.`
    : `"${name}" is already set up on this computer for a different business folder:\n    ${folder}\n  One computer runs one business folder's automations (they share the same names), so I haven't changed it. To run them from this folder instead, first open that other folder with your assistant and say "turn off my automations" (or run "node system/schedule-automation.js remove --name ${name}" there), then run this again here. If this is your NEW copy after an upgrade, copy the old folder's system/.state into this one and run this again (or say "yes, that's my old copy" so I can take them over). Don't delete the old folder until everything works here.`);
  e.code = 'OTHER_FOLDER';
  return e;
}

function parseArgs(argv) {
  const verb = argv[2];
  const opts = { dryRun: false };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--take-over') opts.takeOver = true; // only after the owner says "yes, that's my old copy"
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
  }
  return { verb, opts };
}

// Script args are kept to a safe character set — they end up inside a .bat / plist / crontab.
function safeArgs(args) {
  const s = String(args || '').trim();
  if (s && !/^[A-Za-z0-9 ._=:\/-]+$/.test(s)) throw new Error(`--args may only contain letters, numbers, spaces and . _ = : / - (got "${s}")`);
  return s;
}

// Which working days this job runs on. Daily = every working day; weekly = one day.
function jobDays(freq, day, cfg) {
  if (freq === 'weekly') {
    const d = day || cfg.days[0];
    if (!cfg.days.includes(d)) {
      console.log(`Note: ${d} isn't in the working days — using ${cfg.days[0]} instead so it actually runs.`);
      return [cfg.days[0]];
    }
    return [d];
  }
  return cfg.days; // daily-on-workdays
}

// ── Windows ───────────────────────────────────────────────────────────────
function writeBatWrapper(job) {
  if (!fs.existsSync(WRAPPER_DIR)) fs.mkdirSync(WRAPPER_DIR, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const scriptAbs = path.join(SYSTEM_DIR, job.script);
  const logAbs = path.join(LOG_DIR, `${job.name}.log`);
  // CRLF line endings are REQUIRED — LF-only .bat files fail silently on Windows. The full path to
  // node is used because Task Scheduler doesn't always see the same PATH as the user's session.
  // The file is UTF-8, but cmd reads a .bat in the OEM code page, so a non-ASCII folder or user name
  // (a user folder with an accent, like "…\Users\<name-with-é>\…") pointed nowhere — "chcp 65001" switches cmd to UTF-8 for the lines after it.
  // A "%" in a path must be doubled or cmd treats it as a variable.
  const q = (p) => `"${String(p).replace(/%/g, '%%')}"`;
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'set AIB_SCHEDULED=1',
    `cd /d ${q(SYSTEM_DIR)}`,
    // Rotate the log once it passes 2 MB (rename to .log.1), so it never grows forever.
    `for %%A in (${q(logAbs)}) do if %%~zA GTR 2097152 move /y ${q(logAbs)} ${q(logAbs + '.1')} >nul`,
    `echo ===== %DATE% %TIME% >> ${q(logAbs)}`,
    `${q(process.execPath)} ${q(scriptAbs)}${job.args ? ' ' + job.args : ''} >> ${q(logAbs)} 2>&1`,
    '',
  ];
  const batPath = path.join(WRAPPER_DIR, `${job.name}.bat`);
  fs.writeFileSync(batPath, lines.join('\r\n'), 'utf8');
  return batPath;
}

function psQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// Our Task Scheduler tasks as they're registered right now: Map of task name ->
// { folder, boundaries }. folder = the system folder the task runs from (its working directory, or
// for a basic-mode task the folder its wrappers\*.bat sits in); boundaries = each trigger's
// StartBoundary. null when Task Scheduler can't be read (never throws).
let winTaskCache;
function readWindowsTasks({ fresh = false } = {}) {
  if (os.platform() !== 'win32') return null;
  if (winTaskCache !== undefined && !fresh) return winTaskCache;
  const ps = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$r = @(Get-ScheduledTask -TaskName ${psQuote(TASK_PREFIX + '*')} -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ n = $_.TaskName; wd = (@($_.Actions | ForEach-Object { $_.WorkingDirectory }) -join '|'); ex = (@($_.Actions | ForEach-Object { $_.Execute }) -join '|'); sb = @($_.Triggers | ForEach-Object { [string]$_.StartBoundary }) } })`,
    'ConvertTo-Json -InputObject $r -Compress -Depth 3',
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    let rows = JSON.parse(String(out).replace(/^\uFEFF/, '').trim() || '[]');
    if (!Array.isArray(rows)) rows = [rows];
    const map = new Map();
    for (const r of rows) {
      if (!r || !r.n) continue;
      let folder = String(r.wd || '').split('|').find(Boolean) || null;
      if (!folder) {
        const bat = String(r.ex || '').split('|').find(Boolean);
        const clean = bat ? bat.replace(/^"|"$/g, '') : '';
        if (/\.bat$/i.test(clean) && path.basename(path.dirname(clean)).toLowerCase() === 'wrappers') folder = path.dirname(path.dirname(clean));
      }
      map.set(r.n, { folder, boundaries: (Array.isArray(r.sb) ? r.sb : [r.sb]).filter(Boolean).map(String) });
    }
    winTaskCache = map;
  } catch (_) { winTaskCache = null; }
  return winTaskCache;
}

// A trigger time saved WITH a zone ("…T14:45:00Z" or "…-04:00") makes Task Scheduler keep it in
// that zone ("synchronize across time zones"). After the clock changes for daylight saving, the job
// then fires an hour off — early enough, or late enough, that the working-hours guard skips it on
// every run until the clock changes back. Our triggers are saved as plain local times instead.
function zonedBoundary(sb) { return /(Z|[+-]\d{2}:\d{2})$/i.test(String(sb || '').trim()); }
// Only this business's jobs count: a task on this folder's list that runs from this folder (or from
// a folder that no longer exists — reregister takes those over). Another business folder's task is
// that folder's to fix, and flagging it here meant the warning could never clear.
function zonedWindowsTasks(m = readManifest()) {
  const tasks = readWindowsTasks();
  if (!tasks) return [];
  const names = new Set(((m && m.jobs) || []).map((j) => TASK_PREFIX + j.name));
  return [...tasks].filter(([name, t]) => names.has(name)
    && (!t.folder || sameFolder(t.folder, SYSTEM_DIR) || !fs.existsSync(t.folder))
    && t.boundaries.some(zonedBoundary)).map(([name]) => name);
}

function addWindows(job, cfg, dryRun) {
  const taskName = TASK_PREFIX + job.name;
  if (!dryRun) {
    const existing = (readWindowsTasks() || new Map()).get(taskName);
    if (existing) checkFolder(job.name, existing.folder);
  }
  const batPath = dryRun ? path.join(WRAPPER_DIR, `${job.name}.bat`) : writeBatWrapper(job);
  let trigger, summary, schtasksArgs;
  if (job.freq === 'hourly') {
    // Runs every hour all day; the in-script working-hours guard skips off-hours runs.
    trigger = `New-ScheduledTaskTrigger -Once -At ${psQuote(cfg.start)} -RepetitionInterval (New-TimeSpan -Hours 1)`;
    schtasksArgs = ['/SC', 'HOURLY', '/MO', '1', '/ST', cfg.start];
    summary = 'runs hourly (acts only within working hours)';
  } else {
    const days = jobDays(job.freq, job.day, cfg);
    const runDays = job.freq === 'weekly' ? catchUpDays(days, cfg) : days;
    const st = suggestedRunTime(cfg, job.offset);
    trigger = `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${runDays.map((d) => DAY_NAMES[d]).join(',')} -At ${psQuote(st)}`;
    schtasksArgs = ['/SC', 'WEEKLY', '/D', runDays.map((d) => d.toUpperCase()).join(','), '/ST', st];
    summary = `runs ${job.freq} on ${days.join(', ')} at ${st}${runDays.length > days.length ? ' (catches up on a later working day if that one is missed)' : ''}`;
  }
  const ps = [
    '$ErrorActionPreference = "Stop"',
    `$a = New-ScheduledTaskAction -Execute ${psQuote(batPath)} -WorkingDirectory ${psQuote(SYSTEM_DIR)}`,
    `$t = ${trigger}`,
    // New-ScheduledTaskTrigger stores the start in UTC ("…Z"), which Task Scheduler then keeps in
    // UTC across daylight-saving changes (see zonedBoundary). Rewrite it as plain local time.
    "$t | ForEach-Object { $_.StartBoundary = ([datetime]$_.StartBoundary).ToString('s') }",
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)',
    `Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $a -Trigger $t -Settings $s -Force | Out-Null`,
  ].join('; ');
  if (dryRun) {
    console.log(`DRY RUN (PowerShell): ${ps}`);
    return;
  }
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'pipe' });
  } catch (e) {
    // Fallback for locked-down machines: plain schtasks (battery/catch-up defaults can't be set here).
    execFileSync('schtasks', ['/Create', '/TN', taskName, '/TR', `"${batPath}"`, ...schtasksArgs, '/F'], { stdio: 'pipe' });
    summary += ' (basic mode — keep the laptop plugged in during working hours)';
  }
  console.log(`Scheduled "${job.name}" — ${summary}. ✅`);
}

function removeWindows(name, dryRun) {
  const taskName = TASK_PREFIX + name;
  if (dryRun) return console.log(`DRY RUN: schtasks /Delete /TN ${taskName} /F`);
  try {
    execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'pipe' });
  } catch (_) {}
  const bat = path.join(WRAPPER_DIR, `${name}.bat`);
  if (fs.existsSync(bat)) fs.unlinkSync(bat);
  console.log(`Removed "${name}". ✅`);
}

function listWindows() {
  try {
    const out = execSync('schtasks /Query /FO LIST', { encoding: 'utf8' });
    const ours = out.split('\n').filter((l) => l.includes(TASK_PREFIX));
    console.log(ours.length ? ours.join('\n') : 'No automations scheduled yet.');
  } catch (_) {
    console.log('Could not read scheduled tasks.');
  }
}

// ── Mac (launchd) ─────────────────────────────────────────────────────────
const plistPath = (name) => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_PREFIX}${name}.plist`);
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Homebrew runs node from a versioned folder (<prefix>/Cellar/<formula>/<version>/bin/node, e.g.
// /opt/homebrew/Cellar/node@22/22.9.0/bin/node) and deletes that folder on the next "brew upgrade"
// — every job then points at nothing. Homebrew keeps <prefix>/opt/<formula>/bin/node pointing at
// the current version of that same formula, so that's used when it exists. <prefix>/bin/node is the
// fallback only when it leads into the same formula (it may belong to a different node@ version).
function stableNodePath(execPath = process.execPath, { exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  const m = String(execPath).match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
  if (!m) return execPath;
  const [, prefix, formula] = m;
  const opt = `${prefix}/opt/${formula}/bin/node`;
  try { if (exists(opt)) return opt; } catch (_) {}
  const bin = `${prefix}/bin/node`;
  try { if (exists(bin) && String(realpath(bin)).startsWith(`${prefix}/Cellar/${formula}/`)) return bin; } catch (_) {}
  return execPath;
}

// What an existing plist of ours says: its working folder and the node it starts. {} if unreadable.
function readPlistInfo(file) {
  let xml;
  try { xml = fs.readFileSync(file, 'utf8'); } catch (_) { return {}; }
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const wd = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  const prog = xml.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/);
  return { workingDir: wd ? unesc(wd[1]) : null, node: prog ? unesc(prog[1]) : null };
}

function buildPlist(job, cfg) {
  const scriptAbs = path.join(SYSTEM_DIR, job.script);
  const logAbs = path.join(LOG_DIR, `${job.name}.log`);
  // Runs through lib/logrotate.js so the log is rotated at 2 MB before the job writes to it.
  const argv = [stableNodePath(), path.join(SYSTEM_DIR, 'lib', 'logrotate.js'), job.name, scriptAbs, ...(job.args ? job.args.split(/\s+/) : [])];
  let when, summary;
  if (job.freq === 'hourly') {
    when = '<key>StartCalendarInterval</key><dict><key>Minute</key><integer>0</integer></dict>';
    summary = 'runs hourly (acts only within working hours)';
  } else {
    const days = jobDays(job.freq, job.day, cfg);
    const runDays = job.freq === 'weekly' ? catchUpDays(days, cfg) : days;
    const [hh, mm] = suggestedRunTime(cfg, job.offset).split(':').map(Number);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    when = '<key>StartCalendarInterval</key><array>' + runDays.map((d) =>
      `<dict><key>Weekday</key><integer>${map[d]}</integer><key>Hour</key><integer>${hh}</integer><key>Minute</key><integer>${mm}</integer></dict>`).join('') + '</array>';
    summary = `runs ${job.freq} on ${days.join(', ')} at ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}${runDays.length > days.length ? ' (catches up on a later working day if that one is missed)' : ''}`;
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCHD_PREFIX}${xmlEsc(job.name)}</string>
<key>ProgramArguments</key><array>${argv.map((a) => `<string>${xmlEsc(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xmlEsc(SYSTEM_DIR)}</string>
<key>EnvironmentVariables</key><dict><key>AIB_SCHEDULED</key><string>1</string></dict>
${when}
<key>StandardOutPath</key><string>${xmlEsc(logAbs)}</string>
<key>StandardErrorPath</key><string>${xmlEsc(logAbs)}</string>
<key>RunAtLoad</key><false/>
</dict></plist>
`;
  return { xml, summary };
}

function addMac(job, cfg, dryRun) {
  const { xml, summary } = buildPlist(job, cfg);
  const p = plistPath(job.name);
  if (dryRun) return console.log(`DRY RUN: write ${p}\n${xml}`);
  if (fs.existsSync(p)) checkFolder(job.name, readPlistInfo(p).workingDir);
  const warn = protectedFolderWarning();
  if (warn) console.log(`⚠️  ${warn}`);
  // A node that lives inside an app bundle (e.g. one an editor or the Claude app ships) moves or
  // disappears when that app updates, and every plist then points at nothing.
  if (/\.app\/Contents\//.test(process.execPath)) console.log(`⚠️  Node is running from inside an app (${process.execPath}). If that app updates, your scheduled jobs stop. Install Node from nodejs.org, then run "reregister".`);
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const uid = process.getuid ? process.getuid() : '';
  const label = `${LAUNCHD_PREFIX}${job.name}`;
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch (_) {}
  fs.writeFileSync(p, xml);
  // A job disabled earlier (an old "unload -w" left a persistent override) must be re-enabled first,
  // or bootstrap loads it and it never fires.
  try { execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch (_) {}
  try { execFileSync('launchctl', ['bootstrap', `gui/${uid}`, p], { stdio: 'pipe' }); }
  catch (_) { execFileSync('launchctl', ['load', p], { stdio: 'pipe' }); }
  // Clean up any cron entry an older version of this tool created for the same job. If the crontab
  // can't be rewritten the old entry keeps firing alongside the new job, so say so plainly.
  try { const c = readCrontab(); if (c.includes(`${CRON_TAG} ${job.name}`)) writeCrontab(stripJob(c, job.name)); }
  catch (e) { console.log(`⚠️  Couldn't remove the old-style schedule for "${job.name}" (the crontab couldn't be rewritten: ${e.message}). It may run twice until it's cleared — ask your assistant to "check my automations".`); }
  // A job in a folder macOS blocks is registered but will never run — say so on the success line
  // itself, so the assistant can't read "✅" and move on. (A folder on an external drive may run.)
  if (warn && String(SYSTEM_DIR).startsWith('/Volumes/')) console.log(`Scheduled "${job.name}" — ${summary}. ⚠️ (only runs while that drive is connected — see the warning above)`);
  else if (warn) console.log(`Scheduled "${job.name}" — ${summary}. ⚠️ (will NOT run until the folder is moved to your home folder — see the warning above)`);
  else console.log(`Scheduled "${job.name}" — ${summary}. ✅`);
}

function removeMac(name, dryRun) {
  const p = plistPath(name);
  const uid = process.getuid ? process.getuid() : '';
  if (dryRun) return console.log(`DRY RUN: launchctl bootout gui/${uid}/${LAUNCHD_PREFIX}${name} + delete ${p}`);
  // bootout by service target; the plain "unload" fallback has no -w on purpose: "-w" writes a
  // persistent disabled override that used to keep the job dead after it was added again.
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_PREFIX}${name}`], { stdio: 'ignore' }); } catch (_) {
    try { execFileSync('launchctl', ['unload', p], { stdio: 'ignore' }); } catch (__) {}
  }
  if (fs.existsSync(p)) fs.unlinkSync(p);
  try { const c = readCrontab(); if (c.includes(`${CRON_TAG} ${name}`)) writeCrontab(stripJob(c, name)); }
  catch (e) { console.log(`⚠️  Couldn't remove the old-style schedule for "${name}" (the crontab couldn't be rewritten: ${e.message}).`); }
  console.log(`Removed "${name}". ✅`);
}

// Our launchd jobs that are registered on this Mac but no longer in the job list (a renamed job, the
// old four separate content jobs, a job removed while the folder was elsewhere). They keep firing a
// script nobody expects — or one that no longer exists. Only jobs that belong to THIS business
// count: the plist's working folder is this system folder, the folder it was moved from, or a folder
// that no longer exists. A job pointing at another business folder that still exists is left alone.
// Returns [{ name, plist, removable, workingDir }]; [] off a Mac or on any error.
// removable: its folder is this one, the one it moved from, or none is recorded — safe to delete.
// A job whose folder is simply gone, but was never this business's folder, is only REPORTED: it may
// belong to another business folder on a drive that isn't plugged in right now.
function orphanMacJobs(manifest = readManifest(), { home = os.homedir(), force = false } = {}) {
  if (os.platform() !== 'darwin' && !force) return [];
  const known = new Set(((manifest && manifest.jobs) || []).map((j) => j.name));
  // No saved list at all (never set up, or the list was lost): nothing can be called an orphan.
  if (!known.size) return [];
  const ours = [SYSTEM_DIR, manifest && manifest.installPath, ...((manifest && manifest.previousPaths) || [])].filter(Boolean);
  const dir = path.join(home, 'Library', 'LaunchAgents');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(LAUNCHD_PREFIX) && f.endsWith('.plist')); } catch (_) { return []; }
  for (const f of files) {
    const name = f.slice(LAUNCHD_PREFIX.length, -'.plist'.length);
    if (known.has(name)) continue;
    const plist = path.join(dir, f);
    let wd = null;
    try {
      const m = fs.readFileSync(plist, 'utf8').match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
      if (m) wd = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    } catch (_) { continue; }
    const ourFolder = !wd || ours.some((o) => sameFolder(o, wd));
    if (ourFolder) out.push({ name, plist, removable: true, workingDir: wd });
    else if (!fs.existsSync(wd)) out.push({ name, plist, removable: false, workingDir: wd });
  }
  return out;
}

function removeOrphanMacJobs(manifest, dryRun) {
  for (const { name, plist, removable, workingDir } of orphanMacJobs(manifest)) {
    if (!removable) { console.log(`Left old job ${name} alone: it runs from ${workingDir}, which isn't this business folder and isn't there right now. If you don't use it any more, run "remove --name ${name}".`); continue; }
    if (dryRun) { console.log(`DRY RUN: would remove old job ${name} (${plist})`); continue; }
    const uid = process.getuid ? process.getuid() : '';
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_PREFIX}${name}`], { stdio: 'ignore' }); } catch (_) {
      try { execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch (__) {}
    }
    try { fs.unlinkSync(plist); console.log(`Removed old job ${name} (it was no longer in your list of automations).`); }
    catch (e) { console.log(`  Could not remove old job ${name}: ${e.message}`); }
  }
}

function listMac() {
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const ours = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(LAUNCHD_PREFIX)) : [];
  console.log(ours.length ? ours.map((f) => f.replace(LAUNCHD_PREFIX, '').replace('.plist', '')).join('\n') : 'No automations scheduled yet.');
  const warn = protectedFolderWarning();
  if (warn) console.log(`\n⚠️  ${warn}`);
}

// ── Linux (cron) ──────────────────────────────────────────────────────────
function cronDow(days) {
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return days.map((d) => map[d]).sort((a, b) => a - b).join(',');
}

function readCrontab() {
  try {
    return execSync('crontab -l', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (_) {
    return '';
  }
}

function writeCrontab(content) {
  const tmp = path.join(os.tmpdir(), `aib-cron-${process.pid}.txt`);
  fs.writeFileSync(tmp, content.endsWith('\n') ? content : content + '\n');
  execSync(`crontab "${tmp}"`);
  fs.unlinkSync(tmp);
}

// Old versions of this tool scheduled Mac jobs with cron. Each block is a tag line
// ("# >>> AI-Business-Builder <job>") plus the cron line after it. A block counts as this
// business's when its "cd" folder is this one, the folder it moved from, or no longer exists (or
// can't be read) — the same rule as orphanMacJobs. Returns [{ name, folder, tagLine }].
// The line after a tag is only treated as ours when it looks like one of our job lines. Every
// version wrote one of these (see _Backups):
//   now / round 4+ : <when> export AIB_SCHEDULED=1; cd '<dir>' && '<node>' '<dir>/lib/logrotate.js' <job> '<script>.js' >> '<log>' 2>&1
//   round 3        : <when> cd '<dir>' && '<node>' '<script>.js' [args] >> '<log>' 2>&1
//   first upgrade  : <when> cd "<dir>" && "<node>" "<script>.js" [args] >> "<log>" 2>&1
//   pre-upgrade    : <when> cd "<dir>" && "<node>" "<script>.js"
// Otherwise the line is the owner's own (our job line was hand-deleted): it is kept, and so is the
// tag above it, so nothing of the owner's is removed and the tag can still be seen.
const isOurCronLine = (l) => {
  const s = String(l || '');
  if (/AIB_SCHEDULED|logrotate\.js/.test(s)) return true;
  return /^\s*(?:\S+\s+){5}cd\s+("[^"]*"|'(?:[^']|'\\'')*'|\S+)\s+&&\s+.*\.js["']?(?:\s|$)/.test(s);
};
function oldCronBlocks(content, manifest = readManifest()) {
  const ours = [SYSTEM_DIR, manifest && manifest.installPath, ...((manifest && manifest.previousPaths) || [])].filter(Boolean);
  const lines = String(content || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(CRON_TAG)) continue;
    const name = lines[i].slice(CRON_TAG.length).trim();
    if (!isOurCronLine(lines[i + 1])) continue; // a tag with no job line under it: left as it is
    const m = String(lines[i + 1] || '').match(/\bcd\s+(?:'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+))/);
    const folder = m ? (m[1] !== undefined ? m[1].replace(/'\\''/g, "'").replace(/\\%/g, '%') : (m[2] !== undefined ? m[2] : m[3])) : null;
    const mine = !folder || ours.some((o) => sameFolder(o, folder)) || !fs.existsSync(folder);
    if (mine) out.push({ name, folder, tagLine: lines[i] });
  }
  return out;
}
function stripOldCronBlocks(content, blocks) {
  const tags = new Set(blocks.map((b) => b.tagLine));
  return String(content).split('\n').filter((l, i, arr) => !tags.has(l) && !(tags.has(arr[i - 1]) && isOurCronLine(l))).join('\n');
}

function stripJob(content, name) {
  // Remove any existing block for this job (tag line + its cron line).
  const marker = `${CRON_TAG} ${name}`;
  return content
    .split('\n')
    .filter((l, i, arr) => !(l === marker && isOurCronLine(arr[i + 1])) && !(arr[i - 1] === marker && isOurCronLine(l)))
    .join('\n');
}

function addLinux(job, cfg, dryRun) {
  const scriptAbs = path.join(SYSTEM_DIR, job.script);
  const logAbs = path.join(LOG_DIR, `${job.name}.log`);
  let cronExpr, summary;
  if (job.freq === 'hourly') {
    cronExpr = '0 * * * *';
    summary = 'runs hourly (acts only within working hours)';
  } else {
    const days = jobDays(job.freq, job.day, cfg);
    const runDays = job.freq === 'weekly' ? catchUpDays(days, cfg) : days;
    const [hh, mm] = suggestedRunTime(cfg, job.offset).split(':');
    cronExpr = `${Number(mm)} ${Number(hh)} * * ${cronDow(runDays)}`;
    summary = `runs ${job.freq} on ${days.join(',')} at ${hh}:${mm}${runDays.length > days.length ? ' (catches up on a later working day if that one is missed)' : ''}`;
  }
  // Single-quote for sh (a "$" or backtick in a folder name stays literal; O'Brien becomes 'O'\''Brien'),
  // and escape "%", which cron would otherwise turn into a newline.
  const sq = (p) => `'${String(p).replace(/'/g, "'\\''")}'`.replace(/%/g, '\\%');
  // lib/logrotate.js rotates the log at 2 MB, then runs the script with its output appended to it.
  const line = `${cronExpr} export AIB_SCHEDULED=1; cd ${sq(SYSTEM_DIR)} && ${sq(process.execPath)} ${sq(path.join(SYSTEM_DIR, 'lib', 'logrotate.js'))} ${sq(job.name)} ${sq(scriptAbs)}${job.args ? ' ' + job.args : ''} >> ${sq(logAbs)} 2>&1`;
  if (dryRun) return console.log(`DRY RUN: add crontab line:\n${CRON_TAG} ${job.name}\n${line}`);
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const updated = stripJob(readCrontab(), job.name).replace(/\n+$/, '\n') + `${CRON_TAG} ${job.name}\n${line}\n`;
  writeCrontab(updated);
  console.log(`Scheduled "${job.name}" — ${summary}. ✅`);
}

function removeLinux(name, dryRun) {
  if (dryRun) return console.log(`DRY RUN: remove crontab block for ${name}`);
  writeCrontab(stripJob(readCrontab(), name));
  console.log(`Removed "${name}". ✅`);
}

function listLinux() {
  const lines = readCrontab().split('\n').filter((l) => l.includes('AI-Business-Builder') || l.includes(SYSTEM_DIR));
  console.log(lines.length ? lines.join('\n') : 'No automations scheduled yet.');
}

// ── Dispatch ──────────────────────────────────────────────────────────────
const platform = os.platform();
const ADD = platform === 'win32' ? addWindows : platform === 'darwin' ? addMac : addLinux;
const REMOVE = platform === 'win32' ? removeWindows : platform === 'darwin' ? removeMac : removeLinux;
const LIST = platform === 'win32' ? listWindows : platform === 'darwin' ? listMac : listLinux;

function main() {
  const { verb, opts } = parseArgs(process.argv);
  const cfg = loadWorkingHours();

  if (verb === 'add') {
    if (!opts.name || !opts.script) {
      console.log('Need --name and --script.');
      process.exitCode = 1;
      return;
    }
    if (!/^[a-z0-9-]{1,40}$/i.test(opts.name)) { console.log('--name must be letters, numbers and dashes only.'); process.exitCode = 1; return; }
    // The script path ends up inside a .bat / plist / crontab too: same safe character set as --args.
    if (!/^[A-Za-z0-9._\/-]+\.js$/.test(opts.script) || opts.script.split(/[\\/]/).includes('..')) { console.log('--script must be a .js file in the system folder (e.g. check-sales.js).'); process.exitCode = 1; return; }
    if (!fs.existsSync(path.join(SYSTEM_DIR, opts.script))) { console.log(`No script called ${opts.script} in the system folder.`); process.exitCode = 1; return; }
    // A typo ("Weekly", "every day") used to silently become a daily job.
    const freq = String(opts.freq || 'daily').toLowerCase();
    if (!['hourly', 'daily', 'weekly'].includes(freq)) { console.log('--freq must be hourly, daily or weekly.'); process.exitCode = 1; return; }
    let day = opts.day;
    if (day) {
      day = Object.keys(DAY_NAMES).find((d) => String(opts.day).toLowerCase().startsWith(d.toLowerCase()));
      if (!day) { console.log('--day must be a day like Mon, Tue … Sun.'); process.exitCode = 1; return; }
    }
    const job = { name: opts.name, script: opts.script, args: safeArgs(opts.args), freq, day, offset: Number(opts.offset) || 0 };
    takeOverConfirmed = Boolean(opts.takeOver);
    try { ADD(job, cfg, opts.dryRun); }
    catch (e) {
      if (e.code === 'MOVED_ON') { console.log(e.message); return; }
      if (e.code !== 'OTHER_FOLDER') throw e;
      console.log(`⚠️  Not scheduled: ${e.message}`); process.exitCode = 1; return;
    }
    if (opts.dryRun) return;
    recordJob(job);
    // A takeover moves the WHOLE business, not one job: re-point every other saved job too, so none
    // is left running from the old folder while this folder's list says they're here.
    if (approvedFolders.length) {
      const moved = [];
      for (const j of readManifest().jobs || []) {
        if (j.name === job.name) continue;
        try { ADD({ ...j, args: safeArgs(j.args) }, cfg, false); moved.push(j.name); }
        catch (e) { console.log(`  Could not re-point "${j.name}": ${e.message}`); }
      }
      const m = readManifest(); notePreviousPath(m); writeManifest(m);
      if (moved.length) console.log(`Re-pointed your other automations here too: ${moved.join(', ')}. ✅`);
    }
  } else if (verb === 'remove') {
    if (!opts.name) return console.log('Need --name.');
    REMOVE(opts.name, opts.dryRun);
    if (!opts.dryRun) forgetJob(opts.name);
  } else if (verb === 'reregister') {
    // Folder-move self-heal: rebuild every remembered job at the CURRENT folder path.
    const m = readManifest();
    if (!m.jobs || !m.jobs.length) { console.log('No saved automations to re-register yet.'); return; }
    const movedFrom = m.installPath && !sameFolder(m.installPath, SYSTEM_DIR) ? m.installPath : null;
    if (movedFrom) console.log(`Your business folder moved (was: ${movedFrom}). Re-pointing your automations to this folder...`);
    // Every job is rebuilt from scratch, triggers included, so this also rewrites the Windows
    // trigger times as plain local time (see zonedBoundary) — the fix the health check points to.
    takeOverConfirmed = Boolean(opts.takeOver);
    const refused = []; const movedOn = [];
    for (const j of m.jobs) {
      try { ADD({ ...j, args: safeArgs(j.args) }, cfg, opts.dryRun); }
      catch (e) {
        if (e.code === 'MOVED_ON') { if (!movedOn.length) console.log(e.message); movedOn.push(j.name); }
        else if (e.code === 'OTHER_FOLDER') { refused.push(j.name); console.log(`  Did not re-register ${e.message}`); }
        else console.log(`  Could not re-register "${j.name}": ${e.message}`);
      }
    }
    // Mac: clear out launchd jobs of ours that are no longer on the list (see orphanMacJobs).
    // Windows tasks aren't swept: a wrong guess would delete another business folder's automation.
    if (platform === 'darwin') removeOrphanMacJobs(m, opts.dryRun);
    // Mac: clear out the cron entries an older version of this tool made (launchd runs them now).
    if (platform === 'darwin') {
      const c = readCrontab();
      const blocks = oldCronBlocks(c, m);
      if (blocks.length && opts.dryRun) console.log(`DRY RUN: would remove the old-style schedule (crontab) for ${blocks.map((b) => b.name).join(', ')}`);
      else if (blocks.length) {
        try { writeCrontab(stripOldCronBlocks(c, blocks)); console.log(`Removed the old-style schedule (crontab) for ${blocks.map((b) => b.name).join(', ')} — these run through macOS's own scheduler now.`); }
        catch (e) { console.log(`⚠️  Couldn't remove the old-style schedule (the crontab couldn't be rewritten: ${e.message}). Those jobs may run twice until it's cleared.`); }
      }
    }
    if (opts.dryRun) return;
    if (movedOn.length && movedOn.length + refused.length === m.jobs.length && !refused.length) return; // the newer folder has them
    if (refused.length) {
      const all = refused.length === m.jobs.length;
      console.log(`\n⚠️  ${all ? 'None of your automations were' : `${refused.join(', ')} ${refused.length === 1 ? 'was' : 'were'} not`} re-pointed here: ${refused.length === 1 ? 'it belongs' : 'they belong'} to another business folder on this computer (see above).`);
      process.exitCode = 1;
      if (all) return; // nothing moved here: this folder's list stays as it was
    }
    notePreviousPath(m); m.installPath = SYSTEM_DIR; writeManifest(m);
    if (!refused.length) console.log('All set — your automations now point at this folder. ✅');
  } else if (verb === 'list') {
    LIST();
    // The OS listing is just names; say when each job runs so the assistant can translate it.
    const m = readManifest();
    if (m.jobs && m.jobs.length) {
      console.log('\nWhat each job does:');
      for (const j of m.jobs) {
        const when = j.freq === 'hourly' ? 'every hour (inside working hours)' : `${j.freq} on ${jobDays(j.freq, j.day, cfg).join(', ')} at ${suggestedRunTime(cfg, j.offset)}`;
        console.log(`  - ${j.name}: ${j.script}${j.args ? ' ' + j.args : ''} — ${when}`);
      }
    }
    if (installMoved()) console.log('\n⚠️ Heads up: your folder appears to have moved. Run "reregister" to fix your schedules.');
  } else {
    console.log('Verbs: add | remove | reregister | list  (see top of file for examples)');
  }
}

module.exports = { installMoved, readManifest, protectedFolderWarning, buildPlist, orphanMacJobs, LOG_DIR,
  readWindowsTasks, zonedBoundary, zonedWindowsTasks, stableNodePath, readPlistInfo, plistPath, readCrontab, oldCronBlocks, otherLiveFolder, sameFolder };
if (require.main === module) {
  try { main(); } catch (e) { console.log(`Scheduler error: ${e.message}`); process.exitCode = 1; }
}
