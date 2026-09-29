// Working-hours helper — the reliability layer.
// Because Claude/automations only run when the computer is ON, every scheduled job
// is (a) registered to fire INSIDE the user's working window, and (b) guarded at
// startup so it refuses to run outside that window even if the OS fires it oddly
// (e.g. a laptop waking from sleep and catching up a missed job).

const fs = require('fs');
const path = require('path');

const DAY_CODES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A missing or broken working-hours.json (deleted by accident, a stray comma from a hand edit) used
// to throw, so the sale watcher, the poster and even the health check crashed on every run. Now the
// safe default window is used and the owner is told ONCE per run, in plain words.
const DEFAULT_HOURS_NOTE = 'working-hours.json is missing or unreadable — using Mon–Fri 09:00–17:00. Ask your assistant to set your working hours.';
let fileProblem = null; // set when the last load fell back to the defaults (the health check reports it)
let noted = false;

function loadWorkingHours(file) {
  const p = file || path.join(__dirname, '..', 'working-hours.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); // Notepad can add a BOM
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not a settings object');
    fileProblem = null;
  } catch (_) {
    cfg = {};
    fileProblem = DEFAULT_HOURS_NOTE;
    if (!noted) { noted = true; console.log(DEFAULT_HOURS_NOTE); }
  }
  // Defaults keep things safe if a field is missing. Days/times are normalized because a hand edit
  // like "monday" or "9am" never matched, so every job skipped itself forever without a word.
  const days = (Array.isArray(cfg.days) ? cfg.days : [])
    .map((d) => DAY_CODES.find((c) => String(d).trim().toLowerCase().startsWith(c.toLowerCase())))
    .filter(Boolean);
  const hhmm = (v, dflt) => {
    const m = String(v || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return dflt;
    let h = Number(m[1]);
    const mm = Number(m[2] || 0);
    if (m[3]) { if (h < 1 || h > 12) return dflt; h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0); }
    if (h === 24 && mm === 0) return '23:59'; // "until midnight"
    return h < 24 && mm < 60 ? `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}` : dflt;
  };
  return {
    days: days.length ? [...new Set(days)] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    start: hhmm(cfg.start, '09:00'),
    end: hhmm(cfg.end, '17:00'),
  };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Is the given time inside the working window?
function isWithinWorkingHours(when, cfg) {
  const c = cfg || loadWorkingHours();
  const d = when || new Date();
  const dayOk = c.days.includes(DAY_CODES[d.getDay()]);
  const mins = d.getHours() * 60 + d.getMinutes();
  const s = toMinutes(c.start), e = toMinutes(c.end);
  if (e < s) {
    // Overnight window (e.g. 20:00–02:00): after-midnight minutes belong to the previous day's shift.
    if (mins >= s) return dayOk;
    const prev = DAY_CODES[(d.getDay() + 6) % 7];
    return mins <= e && c.days.includes(prev);
  }
  return dayOk && mins >= s && mins <= e;
}

// What "the computer is on" means for a background job, in the owner's words. On a Mac a launchd
// user agent also needs the owner logged in (a locked screen is fine); logged out = nothing runs.
const ON_WORDS = process.platform === 'darwin'
  ? 'on, awake and you\'re logged in (locked is fine)'
  : 'on and awake';

// A guard for the top of any automation: exits quietly if we're off-hours.
// Usage at the top of a job:  require('./lib/working-hours').guardOrExit('weekly-digest');
//
// Inside the weekly content chain (weekly-content.js sets AIB_IN_CHAIN=1) the steps skip this check:
// the chain itself was checked when it started, and a long render that ran past closing time used
// to make the NEXT step (say, the writer at 16:58 after research took ten minutes) exit as
// "outside working hours" — the week then came out half done.
function guardOrExit(jobName) {
  if (String(process.env.AIB_IN_CHAIN || '') === '1') return;
  if (!isWithinWorkingHours()) {
    console.log(`[${jobName}] Outside working hours — skipping this run. (This is normal and safe: jobs only run while the computer is ${ON_WORDS}, inside your working hours.)`);
    process.exit(0);
  }
}

// ── Weekly catch-up ──────────────────────────────────────────────────────────────────────────────
// A weekly job that was missed (computer off, or a Mac that was logged out at the time — launchd
// only catches up a job the Mac slept through) used to be lost for a whole week. So the scheduler
// registers weekly jobs on their day AND every following working day, and the job itself records
// each successful run here: a scheduled catch-up run that finds a run in the last few days exits
// quietly. On-request runs (the assistant running the script for the owner) are never skipped —
// the scheduler marks its own runs with AIB_SCHEDULED=1.
const STATE_DIR = path.join(__dirname, '..', '.state');
const lastRunFile = (name) => path.join(STATE_DIR, `last-run-${String(name).replace(/[^a-z0-9-]/gi, '-')}.json`);

// Local calendar day number of a timestamp (days since epoch, on the owner's clock). Two runs on
// the same local date are 0 apart, however many hours sit between them.
const localDay = (ms) => { const d = new Date(ms); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); };

// "Ran in the last `days` days" counts LOCAL CALENDAR DATES, not hours: with days = 5 a run dated
// within the last 4 days is recent (today = 0). A raw 5x24h window failed at the clock change: a
// catch-up run two days late plus a one-hour DST shift put the next real run 4d23h later, so it
// was skipped for a whole week. Calendar dates keep the "next two working days" catch-up (7 - 2 = 5)
// and ignore what the clock did in between.
function ranRecently(name, days = 5, now = Date.now()) {
  try {
    const at = JSON.parse(fs.readFileSync(lastRunFile(name), 'utf8').replace(/^﻿/, '')).at;
    if (!Number.isFinite(at)) return false;
    const gap = localDay(now) - localDay(at);
    return gap >= 0 && gap < days;
  } catch (_) { return false; }
}

function markRan(name) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(lastRunFile(name), JSON.stringify({ at: Date.now(), when: new Date().toISOString() }, null, 2));
  } catch (_) { /* a missing state dir must never fail the job itself */ }
}

const isScheduledRun = () => String(process.env.AIB_SCHEDULED || '') === '1';

// Guard for a WEEKLY job: off-hours check, then "already ran this week" (scheduled runs only).
function weeklyGuardOrExit(jobName, days = 5) {
  guardOrExit(jobName);
  if (isScheduledRun() && ranRecently(jobName, days)) {
    console.log(`[${jobName}] Already ran in the last ${days} days — skipping this catch-up run. (This is normal and safe.)`);
    process.exit(0);
  }
}

// Pick a safe time to schedule a daily/weekly job: 30 min after the window opens,
// so the computer has had a moment to wake up and connect.
// `offsetMin` staggers jobs that must run in order (e.g. write content, THEN render it).
function suggestedRunTime(cfg, offsetMin = 0) {
  const c = cfg || loadWorkingHours();
  const startMin = toMinutes(c.start);
  let endMin = toMinutes(c.end);
  if (endMin <= startMin) endMin += 24 * 60; // overnight window
  // Aim 30 min after open — but if the window is too short for that buffer, run right at open
  // instead of at the very edge, where the start-of-run guard could skip the job.
  let mins = startMin + 30 + (Number(offsetMin) || 0);
  if (mins > endMin - 15) mins = Math.max(startMin, endMin - 15);
  mins %= 24 * 60;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// null when working-hours.json read fine on the last load, else the plain-words note (health check).
const workingHoursProblem = () => fileProblem;

module.exports = { loadWorkingHours, workingHoursProblem, isWithinWorkingHours, guardOrExit, weeklyGuardOrExit, ranRecently, markRan, isScheduledRun, suggestedRunTime, localDay, DAY_CODES, ON_WORDS };
