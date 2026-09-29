// The one place the renderers and the poster read and write Content/content-plan.json.
//
// Why a shared save: each job keeps the plan in memory for the length of its run, and two jobs can
// overlap (the weekly content job renders for a while; the daily poster starts 45 minutes later; the
// owner can run a renderer by hand at any time). If each one wrote back its own copy of the whole
// array, the LAST writer would win — a renderer finishing after the poster used to flip an item that
// had just gone public from "posted" back to "rendered", and the poster put it on the page AGAIN the
// next day. So a save here merges into what's on disk: this job's changes are applied item by item,
// and an item another job has already marked "posted" is never un-posted.
//
// The weekly writer (auto-content.js) deliberately does NOT use this — it replaces the plan outright
// after archiving the old one, which is the one time a full overwrite is the intent.
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const PLAN = path.join(ROOT, 'Content', 'content-plan.json');

function loadPlan() {
  try { return JSON.parse(fs.readFileSync(PLAN, 'utf8').replace(/^﻿/, '')); } catch (_) { return []; }
}

function writeAtomic(plan) {
  fs.mkdirSync(path.dirname(PLAN), { recursive: true });
  const tmp = PLAN + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2));
  fs.renameSync(tmp, PLAN);
}

// Merge-save: start from what's on disk, apply this job's version of each item it knows about, keep
// the poster's verdicts. If the ids can't be trusted (an item without one) fall back to a plain write.
//
// "posted" is public and can never be rolled back. "skipped" (too late to post) and "manual" (needs
// the owner's hands) are the poster's final word on an item too: a renderer that loaded the plan
// before the poster ran used to save its stale "rendered" copy over them, so the owner was pinged
// about the same manual reel every day and a late post was re-judged on every run. Only the owner
// (with their assistant) moves an item out of these states, by editing the plan on disk — and a job
// that loaded the plan after that edit sees the new status, so it is never blocked here.
const FINAL = new Set(['posted', 'skipped', 'manual']);
function savePlan(plan) {
  const disk = loadPlan();
  const trusted = (arr) => arr.every((it) => it && typeof it === 'object' && it.id != null);
  if (!Array.isArray(disk) || !disk.length || !trusted(disk) || !trusted(plan)) return writeAtomic(plan);
  const mine = new Map(plan.map((it) => [String(it.id), it]));
  const merged = disk.map((d) => {
    const m = mine.get(String(d.id));
    if (!m) return d; // something this job never saw (e.g. added by the owner meanwhile) stays
    if (FINAL.has(d.status) && m.status !== d.status) return d; // the poster's verdict stands
    return m;
  });
  // Items this job has that the disk no longer has: the weekly writer replaced the plan meanwhile
  // (last week's items were archived), so they are left out on purpose.
  writeAtomic(merged);
  // Keep the caller's array in step with what was saved, so a later save in the same run can't
  // reintroduce a rolled-back status.
  for (const d of merged) { const m = mine.get(String(d.id)); if (m && m !== d) Object.assign(m, d); }
}

// ── Media paths in the plan ──────────────────────────────────────────────────────────────────────
// Rendered files used to be recorded as full paths (e.g. "D:\My Business\Content\rendered\x.png").
// Moving or renaming the business folder then broke posting: every path pointed at the old place,
// the poster found no file, and each post failed as "no rendered image". Paths are now stored
// relative to the business folder ("Content/rendered/x.png", forward slashes on every computer),
// and reading one also copes with the old full paths.
function toPlanPath(abs) {
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return abs; // outside the folder: keep as is
  return rel.split(path.sep).join('/');
}

// The file on THIS computer for a recorded media path, or null when it can't be found:
//   1. a relative path, inside the business folder
//   2. an old full path, if it still exists
//   3. either one's file name in Content/rendered/ (the folder moved since it was recorded)
function resolveMedia(p, root = ROOT) {
  if (!p || typeof p !== 'string') return null;
  const direct = path.isAbsolute(p) ? p : path.join(root, p);
  if (fs.existsSync(direct)) return direct;
  const base = p.split(/[\\/]/).pop();
  const fallback = base ? path.join(root, 'Content', 'rendered', base) : null;
  return fallback && fs.existsSync(fallback) ? fallback : null;
}

module.exports = { loadPlan, savePlan, PLAN, toPlanPath, resolveMedia };
