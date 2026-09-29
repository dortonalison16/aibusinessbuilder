// Tiny JSON state store — remembers which sales we've already handled, so a buyer is never
// emailed twice and a sale is never double-counted. Lives in system/.state/.
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', '.state');

function statePath(name) {
  return path.join(STATE_DIR, `${name}.json`);
}

function readSet(name) {
  try {
    const arr = JSON.parse(fs.readFileSync(statePath(name), 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) {
    return new Set();
  }
}

function writeSet(name, set) {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  // Atomic write: a crash mid-write can never leave a half-written (corrupt) state file —
  // we write to a temp file and rename it into place (rename is atomic on the same volume).
  const tmp = statePath(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...set], null, 2));
  fs.renameSync(tmp, statePath(name));
}

module.exports = { readSet, writeSet };
