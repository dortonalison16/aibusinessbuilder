// Keeps Content/rendered/ from growing forever. Every week adds ~9 files (MP4s included) and nothing
// ever removed them. A rendered file is deleted only when ALL of these hold:
//   - it belongs to an item in a plan archived (Content/history/) more than 8 weeks ago, and
//   - no item in the current plan refers to it, and
//   - no item in ANY plan archived in the last 8 weeks refers to it, whatever its status.
// Status doesn't matter for keeping: a hand-written plan reuses ids like "w1-01" week after week, so
// an old plan's "w1-01" can name the very file a recent "rendered" or "manual" item still needs.
// Only files directly inside Content/rendered/ are ever touched — never Content/ads/, clips/,
// images/ or Product/. Failing to prune must never fail the job that called it.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const CONTENT_DIR = path.join(ROOT, 'Content');
const HISTORY_DIR = path.join(CONTENT_DIR, 'history');
const RENDERED_DIR = path.join(CONTENT_DIR, 'rendered');
const PLAN = path.join(CONTENT_DIR, 'content-plan.json');
const KEEP_MS = 8 * 7 * 864e5;

function readJson(p) { try { const v = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); return Array.isArray(v) ? v : []; } catch (_) { return []; } }

// When a history file was archived: the date in its name (content-plan-2026-09-28[-2].json), else
// its modified time.
function archivedAt(file) {
  const m = path.basename(file).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  try { return fs.statSync(file).mtimeMs; } catch (_) { return Date.now(); }
}

// The rendered files an item is responsible for: its recorded mediaPaths, plus anything named after
// its id (<id>.png, <id>-slide-3.png, <id>.mp4) in case the plan was edited by hand.
function filesOf(item, names) {
  const out = new Set();
  for (const p of Array.isArray(item.mediaPaths) ? item.mediaPaths : []) out.add(path.basename(String(p)));
  const id = item.id != null ? String(item.id) : '';
  if (id) for (const n of names) if (n === `${id}.png` || n === `${id}.mp4` || n.startsWith(`${id}-slide-`) || n.startsWith(`${id}.`)) out.add(n);
  return out;
}

function pruneRendered({ now = Date.now(), log = console.log } = {}) {
  let names;
  try { names = fs.readdirSync(RENDERED_DIR).filter((n) => !n.startsWith('.')); } catch (_) { return { removed: [] }; }
  if (!names.length) return { removed: [] };
  const isFile = (n) => { try { return fs.statSync(path.join(RENDERED_DIR, n)).isFile(); } catch (_) { return false; } };
  names = names.filter(isFile);

  const keep = new Set();
  const candidates = new Set();
  for (const it of readJson(PLAN)) for (const n of filesOf(it, names)) keep.add(n);
  let history = [];
  try { history = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(HISTORY_DIR, f)); } catch (_) {}
  for (const file of history) {
    const old = now - archivedAt(file) > KEEP_MS;
    for (const it of readJson(file)) {
      const files = filesOf(it, names);
      if (old) for (const n of files) candidates.add(n);
      else for (const n of files) keep.add(n);
    }
  }

  const removed = [];
  for (const n of candidates) {
    if (keep.has(n)) continue;
    const full = path.join(RENDERED_DIR, n);
    if (path.dirname(full) !== RENDERED_DIR) continue; // belt and braces: never leave the folder
    try { fs.unlinkSync(full); removed.push(n); } catch (_) { /* in use or already gone — next time */ }
  }
  if (removed.length) log(`Cleaned up ${removed.length} old rendered file(s) from Content/rendered (from plans archived over 8 weeks ago): ${removed.slice(0, 6).join(', ')}${removed.length > 6 ? ', …' : ''}`);
  return { removed };
}

module.exports = { pruneRendered, RENDERED_DIR };
