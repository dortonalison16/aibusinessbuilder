// Working-hours helper — the reliability layer.
// Because Claude/automations only run when the computer is ON, every scheduled job
// is (a) registered to fire INSIDE the user's working window, and (b) guarded at
// startup so it refuses to run outside that window even if the OS fires it oddly
// (e.g. a laptop waking from sleep and catching up a missed job).

const fs = require('fs');
const path = require('path');

const DAY_CODES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function loadWorkingHours(file) {
  const p = file || path.join(__dirname, '..', 'working-hours.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Defaults keep things safe if a field is missing.
  return {
    days: Array.isArray(cfg.days) && cfg.days.length ? cfg.days : ['Mon', 'Tue', 'Wed', 'Thu'],
    start: cfg.start || '10:00',
    end: cfg.end || '16:00',
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
  const inWindow = mins >= toMinutes(c.start) && mins <= toMinutes(c.end);
  return dayOk && inWindow;
}

// A guard for the top of any automation: exits quietly if we're off-hours.
// Usage at the top of a job:  require('./lib/working-hours').guardOrExit('weekly-digest');
function guardOrExit(jobName) {
  if (!isWithinWorkingHours()) {
    console.log(`[${jobName}] Outside working hours — skipping this run. (This is normal and safe.)`);
    process.exit(0);
  }
}

// Pick a safe time to schedule a daily/weekly job: 30 min after the window opens,
// so the computer has had a moment to wake up and connect.
function suggestedRunTime(cfg) {
  const c = cfg || loadWorkingHours();
  const startMin = toMinutes(c.start);
  const endMin = toMinutes(c.end);
  // Aim 30 min after open — but if the window is too short for that buffer (or inverted), run
  // right at open instead of at the very edge, where the start-of-run guard could skip the job.
  let mins = startMin + 30;
  if (endMin <= startMin || mins > endMin - 15) mins = startMin;
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

module.exports = { loadWorkingHours, isWithinWorkingHours, guardOrExit, suggestedRunTime, DAY_CODES };
