// Keeps system/logs/<name>.log from growing forever: once it passes 2 MB it is renamed to
// <name>.log.1 (replacing the previous .1) and a fresh log starts. The health check only ever
// needs the most recent runs.
//
// Two ways in:
//   require('./lib/logrotate').rotate('check-sales')      — from a script, before it logs anything
//   node lib/logrotate.js <name> <script.js> [args…]       — launcher used by the launchd/cron jobs:
//     rotates, then runs the script with its output appended to the (fresh) log. The Windows .bat
//     wrapper does the same size check in one line of batch instead.
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const MAX_BYTES = 2 * 1024 * 1024;

function rotate(name) {
  const log = path.join(LOG_DIR, `${name}.log`);
  try {
    if (fs.existsSync(log) && fs.statSync(log).size > MAX_BYTES) {
      fs.renameSync(log, log + '.1'); // rename replaces an older .1
      return true;
    }
  } catch (_) { /* a log we can't rotate is not a reason to skip the job */ }
  return false;
}

module.exports = { rotate, LOG_DIR, MAX_BYTES };

if (require.main === module) {
  const [name, script, ...args] = process.argv.slice(2);
  if (!name || !script) { console.log('usage: node lib/logrotate.js <job-name> <script.js> [args]'); process.exit(2); }
  rotate(name);
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const fd = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  fs.writeSync(fd, `===== ${new Date().toString()}\n`);
  const { spawnSync } = require('child_process');
  const scriptAbs = path.isAbsolute(script) ? script : path.join(__dirname, '..', script);
  const r = spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', fd, fd], env: { ...process.env, AIB_SCHEDULED: '1' },
  });
  fs.closeSync(fd);
  process.exit(r.status == null ? 1 : r.status);
}
