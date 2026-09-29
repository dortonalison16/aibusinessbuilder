// Cross-platform scheduler — registers an automation to run on a schedule that
// stays INSIDE the user's working hours, so jobs actually fire (the computer is on).
//
// Windows : creates a CRLF .bat wrapper + a Task Scheduler task (schtasks).
// Mac/Linux: writes a tagged crontab entry.
//
// Usage (the assistant runs these for the user). --script is a path relative to system/:
//   node schedule-automation.js add  --name weekly-digest --script weekly-digest.js --freq weekly --day Mon
//   node schedule-automation.js add  --name sale-watch    --script check-sales.js   --freq hourly
//   node schedule-automation.js remove --name weekly-digest
//   node schedule-automation.js reregister   (folder-move self-heal: rebuild all saved jobs here)
//   node schedule-automation.js list
// Add --dry-run to preview the exact command without changing anything.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { loadWorkingHours, suggestedRunTime, DAY_CODES } = require('./lib/working-hours');

const SYSTEM_DIR = __dirname;
const WRAPPER_DIR = path.join(SYSTEM_DIR, 'wrappers');
const TASK_PREFIX = 'AIB_'; // so all our tasks are easy to find/remove
const CRON_TAG = '# >>> AI-Business-Builder';

// ── Job manifest (powers folder-move self-heal) ─────────────────────────────
// Every scheduled job is recorded here along with the path it was registered FROM. If the buyer
// later moves/renames their business folder, the OS tasks point at the old (now-missing) path and
// fail silently. `reregister` reads this manifest and rebuilds every job at the CURRENT path.
const MANIFEST = path.join(SYSTEM_DIR, '.state', 'scheduled-jobs.json');
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (_) { return { installPath: SYSTEM_DIR, jobs: [] }; }
}
function writeManifest(m) {
  const dir = path.dirname(MANIFEST);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = MANIFEST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, MANIFEST);
}
function recordJob(name, script, freq, day) {
  const m = readManifest();
  m.installPath = SYSTEM_DIR; // always reflect where jobs currently point
  m.jobs = (m.jobs || []).filter((j) => j.name !== name);
  m.jobs.push({ name, script, freq: freq || 'daily', day: day || null });
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
  return Boolean(m.installPath && m.jobs && m.jobs.length && path.resolve(m.installPath) !== path.resolve(SYSTEM_DIR));
}

function parseArgs(argv) {
  const verb = argv[2];
  const opts = { dryRun: false };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
  }
  return { verb, opts };
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
function writeBatWrapper(name, scriptRel) {
  if (!fs.existsSync(WRAPPER_DIR)) fs.mkdirSync(WRAPPER_DIR, { recursive: true });
  const scriptAbs = path.join(SYSTEM_DIR, scriptRel);
  // CRLF line endings are REQUIRED — LF-only .bat files fail silently on Windows.
  const lines = [
    '@echo off',
    `cd /d "${SYSTEM_DIR}"`,
    `node "${scriptAbs}"`,
    '',
  ];
  const batPath = path.join(WRAPPER_DIR, `${name}.bat`);
  fs.writeFileSync(batPath, lines.join('\r\n'), 'utf8');
  return batPath;
}

function addWindows(name, scriptRel, freq, day, cfg, dryRun) {
  const batPath = dryRun ? '<wrapper.bat>' : writeBatWrapper(name, scriptRel);
  const taskName = TASK_PREFIX + name;
  let args, summary;
  if (freq === 'hourly') {
    // Runs every hour all day; the in-script working-hours guard skips off-hours runs.
    args = ['/Create', '/TN', taskName, '/TR', `"${batPath}"`, '/SC', 'HOURLY', '/MO', '1', '/ST', cfg.start, '/F'];
    summary = `runs hourly (acts only within working hours)`;
  } else {
    const days = jobDays(freq, day, cfg).map((d) => d.toUpperCase()).join(',');
    const st = suggestedRunTime(cfg);
    args = ['/Create', '/TN', taskName, '/TR', `"${batPath}"`, '/SC', 'WEEKLY', '/D', days, '/ST', st, '/F'];
    summary = `runs ${freq} on ${days} at ${st}`;
  }
  if (dryRun) {
    console.log(`DRY RUN: schtasks ${args.join(' ')}`);
    return;
  }
  execFileSync('schtasks', args, { stdio: 'pipe' });
  console.log(`Scheduled "${name}" — ${summary}. ✅`);
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

// ── Mac / Linux ───────────────────────────────────────────────────────────
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

function stripJob(content, name) {
  // Remove any existing block for this job (tag line + its cron line).
  const marker = `${CRON_TAG} ${name}`;
  return content
    .split('\n')
    .filter((l, i, arr) => l !== marker && arr[i - 1] !== marker)
    .join('\n');
}

function addUnix(name, scriptRel, freq, day, cfg, dryRun) {
  const scriptAbs = path.join(SYSTEM_DIR, scriptRel);
  const nodeBin = process.execPath;
  let cronExpr, summary;
  if (freq === 'hourly') {
    // Every hour; the in-script working-hours guard skips off-hours runs.
    cronExpr = `0 * * * *`;
    summary = `runs hourly (acts only within working hours)`;
  } else {
    const days = jobDays(freq, day, cfg);
    const [hh, mm] = suggestedRunTime(cfg).split(':');
    cronExpr = `${Number(mm)} ${Number(hh)} * * ${cronDow(days)}`;
    summary = `runs ${freq} on ${days.join(',')} at ${hh}:${mm}`;
  }
  const line = `${cronExpr} cd "${SYSTEM_DIR}" && "${nodeBin}" "${scriptAbs}"`;
  if (dryRun) return console.log(`DRY RUN: add crontab line:\n${CRON_TAG} ${name}\n${line}`);
  const updated = stripJob(readCrontab(), name).replace(/\n+$/, '\n') + `${CRON_TAG} ${name}\n${line}\n`;
  writeCrontab(updated);
  console.log(`Scheduled "${name}" — ${summary}. ✅`);
}

function removeUnix(name, dryRun) {
  if (dryRun) return console.log(`DRY RUN: remove crontab block for ${name}`);
  writeCrontab(stripJob(readCrontab(), name));
  console.log(`Removed "${name}". ✅`);
}

function listUnix() {
  const lines = readCrontab().split('\n').filter((l) => l.includes(CRON_TAG.replace('# ', '')) || l.includes('AI-Business-Builder'));
  console.log(lines.length ? lines.join('\n') : 'No automations scheduled yet.');
}

// ── Dispatch ──────────────────────────────────────────────────────────────
function main() {
  const { verb, opts } = parseArgs(process.argv);
  const isWin = os.platform() === 'win32';
  const cfg = loadWorkingHours();

  if (verb === 'add') {
    if (!opts.name || !opts.script) {
      console.log('Need --name and --script.');
      process.exitCode = 1;
      return;
    }
    const freq = opts.freq || 'daily';
    (isWin ? addWindows : addUnix)(opts.name, opts.script, freq, opts.day, cfg, opts.dryRun);
    if (!opts.dryRun) recordJob(opts.name, opts.script, freq, opts.day);
  } else if (verb === 'remove') {
    if (!opts.name) return console.log('Need --name.');
    (isWin ? removeWindows : removeUnix)(opts.name, opts.dryRun);
    if (!opts.dryRun) forgetJob(opts.name);
  } else if (verb === 'reregister') {
    // Folder-move self-heal: rebuild every remembered job at the CURRENT folder path.
    const m = readManifest();
    if (!m.jobs || !m.jobs.length) { console.log('No saved automations to re-register yet.'); return; }
    const movedFrom = m.installPath && path.resolve(m.installPath) !== path.resolve(SYSTEM_DIR) ? m.installPath : null;
    if (movedFrom) console.log(`Your business folder moved (was: ${movedFrom}). Re-pointing your automations to this folder...`);
    for (const j of m.jobs) {
      try { (isWin ? addWindows : addUnix)(j.name, j.script, j.freq, j.day, cfg, opts.dryRun); }
      catch (e) { console.log(`  Could not re-register "${j.name}": ${e.message}`); }
    }
    if (!opts.dryRun) { m.installPath = SYSTEM_DIR; writeManifest(m); console.log('All set — your automations now point at this folder. ✅'); }
  } else if (verb === 'list') {
    (isWin ? listWindows : listUnix)();
    if (installMoved()) console.log('\n⚠️ Heads up: your folder appears to have moved. Run "reregister" to fix your schedules.');
  } else {
    console.log('Verbs: add | remove | reregister | list  (see top of file for examples)');
  }
}

module.exports = { installMoved, readManifest };
if (require.main === module) main();
