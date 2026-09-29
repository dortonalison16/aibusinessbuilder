// Paid sales whose product email did NOT go out. The sale watcher marks every sale as handled
// (so a buyer is never emailed twice and the owner never pinged twice), which on its own meant a
// failed send was forgotten: "all caught up" in the Health Check while a buyer had paid for
// nothing. This list remembers them until a send succeeds — the sale watcher retries them each
// run, and any successful delivery to that address (retry, or a hand re-send) clears the entry.
// Lives in system/.state/undelivered-sales.json.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '.state', 'undelivered-sales.json');
const norm = (e) => String(e || '').trim().toLowerCase();

function list() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
  } catch (_) { return []; }
}

function save(arr) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, FILE); // atomic, same as the other state files
  } catch (_) { /* a state write must never break a delivery run */ }
}

function add({ id, email, name, created, reason }) {
  const arr = list().filter((x) => x.id !== id);
  arr.push({ id, email: email || null, name: name || '', created: created || null, reason: reason || '', at: new Date().toISOString() });
  save(arr);
}

function removeEmail(email) {
  const e = norm(email);
  if (!e) return;
  const arr = list();
  const kept = arr.filter((x) => norm(x.email) !== e);
  if (kept.length !== arr.length) save(kept);
}

module.exports = { list, add, removeEmail, FILE };
