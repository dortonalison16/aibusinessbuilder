// In-place update for an existing Auto-Pilot folder. It ships INSIDE the new version, and is run
// from there against the owner's current folder:
//
//   node "<unzipped new version>/system/update.js" --into "<owner's Machine folder>" [--dry-run]
//
// The owner's folder stays exactly where it is: no second folder, no copying by hand, no takeover.
// What it does, in order:
//   1. Checks both folders are the AI Freedom Machine Auto-Pilot edition (and not the same folder).
//   2. Backs up every file it will replace into <folder>/_before-update-YYYY-MM-DD-HHMM/.
//   3. Copies in the new program files (system code, the agents in .claude/skills, the guides).
//   4. Installs the engine (npm install in system/), re-registers the scheduled jobs from this same
//      folder (which also clears old Mac cron entries), and runs the health check.
//   5. Records the update in system/.state/update-history.json and prints a plain summary.
//
// It NEVER touches the owner's own things: .env (their keys), client-config.md (their business
// profile), Product/, Content/ (it only adds Content/ads/README.txt if missing), system/.state
// (sales already delivered, the sale watcher's start line, the job list), system/logs,
// system/node_modules (npm manages that), their working hours, and every folder or file it
// doesn't know (Sales-Page, Emails, their own skills…). A re-run is safe: identical files are
// skipped and nothing is backed up twice.
//
// --from "<folder>"  the new version, if this script isn't being run from inside it. The unzipped
//                    folder itself or the folder that contains it both work.
// --skip-npm / --skip-schedule / --skip-health   for the assistant's own troubleshooting.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// ── What belongs to the product (replaced) vs. the owner (never touched) ─────────────────────────
const ROOT_FILES = ['GET-STARTED.md', 'CLAUDE.md', 'EDITION.txt', 'READ ME FIRST.txt', 'UPDATING.md', '.env.template'];
const ONLY_IF_MISSING = ['Product/README.txt', 'Content/ads/README.txt', 'system/working-hours.json'];
// Product skills that a newer version no longer ships would be listed here (removed on update).
const RETIRED_SKILLS = [];

function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--skip-npm') o.skipNpm = true;
    else if (a === '--skip-schedule') o.skipSchedule = true;
    else if (a === '--skip-health') o.skipHealth = true;
    else if (a === '--into' || a === '--from') o[a.slice(2)] = argv[++i];
  }
  return o;
}

const exists = (p) => { try { fs.statSync(p); return true; } catch (_) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const read = (p) => { try { return fs.readFileSync(p); } catch (_) { return null; } };
function sameFolder(a, b) {
  const norm = (p) => {
    let r = path.resolve(String(p));
    try { r = fs.realpathSync.native(r); } catch (_) { try { r = fs.realpathSync(r); } catch (__) {} }
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}
const inside = (child, parent) => { const r = path.relative(path.resolve(parent), path.resolve(child)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

// Which edition a folder is: 'Auto-Pilot', 'Co-Pilot', or null (not a Machine folder at all).
// The July (pre-upgrade) build has no EDITION.txt: system/check-sales.js alone marks Auto-Pilot.
function editionOf(dir) {
  const ed = read(path.join(dir, 'EDITION.txt'));
  const first = ed ? String(ed).replace(/^﻿/, '').split(/\r?\n/)[0].trim() : '';
  if (/co-pilot/i.test(first)) return 'Co-Pilot';
  if (/co-pilot/i.test(path.basename(dir)) || exists(path.join(dir, 'Skills - upload each to Claude Desktop'))) return 'Co-Pilot';
  if (exists(path.join(dir, 'system', 'check-sales.js')) && (!first || /^auto-pilot$/i.test(first))) return 'Auto-Pilot';
  return null;
}
function versionOf(dir) {
  const ed = read(path.join(dir, 'EDITION.txt'));
  const m = ed && String(ed).match(/^Version:\s*(\S+)/mi);
  if (m) return m[1];
  return ed ? 'an earlier version' : 'the July version';
}

// The new version: this script's own folder, or --from (the unzipped folder or the one holding it).
function resolveSource(from) {
  const start = path.resolve(from || path.join(__dirname, '..'));
  if (editionOf(start)) return start;
  let kids = [];
  try { kids = fs.readdirSync(start).map((n) => path.join(start, n)).filter(isDir); } catch (_) {}
  return kids.find((k) => editionOf(k) === 'Auto-Pilot') || kids.find((k) => editionOf(k)) || start;
}
function resolveTarget(into) {
  let t = path.resolve(String(into));
  // Pointed at the system folder itself? Use the Machine folder around it.
  if (path.basename(t).toLowerCase() === 'system' && exists(path.join(t, 'check-sales.js'))) t = path.dirname(t);
  return t;
}

function refuse(msg) { console.log(`⚠️  ${msg}\nNothing was changed.`); process.exitCode = 1; return null; }

function validate(src, dst) {
  if (!dst) return refuse('Tell me which folder to update: --into "<your Machine folder>".');
  if (!isDir(dst)) return refuse(`I can't find the folder to update: ${dst}`);
  const se = editionOf(src); const de = editionOf(dst);
  if (se === 'Co-Pilot') return refuse('That download is the Co-Pilot edition. Co-Pilot updates by uploading the new plugin in the Claude app — there is nothing to install into this folder. Use the Auto-Pilot download (AI Freedom Machine - Auto-Pilot.zip) to update an Auto-Pilot folder.');
  if (se !== 'Auto-Pilot' || !exists(path.join(src, 'system', 'update.js'))) return refuse(`The new version wasn't found at ${src} (it should hold system/update.js and EDITION.txt saying Auto-Pilot). Unzip "AI Freedom Machine - Auto-Pilot.zip" and point me at that folder.`);
  if (sameFolder(src, dst)) return refuse('That is the new version itself, not your Machine folder. Point --into at the folder you have been using all along (the one with your .env and client-config.md).');
  if (de === 'Co-Pilot') return refuse(`${dst} is a Co-Pilot folder (the Ads Kit). This update is for the Auto-Pilot edition only.`);
  if (de !== 'Auto-Pilot') return refuse(`${dst} doesn't look like an AI Freedom Machine Auto-Pilot folder (no system/check-sales.js). Open your Machine folder — the one you use in the Code tab — and try again.`);
  if (inside(dst, src)) return refuse('Your Machine folder is inside the new version\'s folder — that can\'t be right. Unzip the new version somewhere else (a temporary folder) and try again.');
  return true;
}

// Every file the new version brings, as { rel, kind }. rel uses forward slashes.
function productFiles(src) {
  const out = [];
  const add = (rel, kind = 'replace') => out.push({ rel: rel.split(path.sep).join('/'), kind });
  const walk = (dirRel, cb) => {
    let names = [];
    try { names = fs.readdirSync(path.join(src, dirRel)); } catch (_) { return; }
    for (const n of names) {
      const rel = path.join(dirRel, n);
      if (isDir(path.join(src, rel))) walk(rel, cb); else cb(rel);
    }
  };
  for (const n of fs.readdirSync(path.join(src, 'system'))) {
    if (/\.js$/.test(n) && !isDir(path.join(src, 'system', n))) add(path.join('system', n));
  }
  walk(path.join('system', 'lib'), (rel) => add(rel));
  for (const f of ['package.json', 'package-lock.json']) if (exists(path.join(src, 'system', f))) add(path.join('system', f));
  for (const f of ROOT_FILES) if (exists(path.join(src, f))) add(f);
  for (const n of fs.readdirSync(src)) if (/\.pdf$/i.test(n) && !isDir(path.join(src, n))) add(n);
  for (const f of ONLY_IF_MISSING) if (exists(path.join(src, f))) add(f, 'if-missing');
  return out;
}
function productSkills(src) {
  try { return fs.readdirSync(path.join(src, '.claude', 'skills')).filter((n) => isDir(path.join(src, '.claude', 'skills', n))); } catch (_) { return []; }
}
function filesUnder(dir) {
  const out = [];
  const walk = (d, rel) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch (_) { return; }
    for (const n of names) { const p = path.join(d, n); const r = rel ? `${rel}/${n}` : n; if (isDir(p)) walk(p, r); else out.push(r); }
  };
  walk(dir, '');
  return out.sort();
}
const sameBytes = (a, b) => { const x = read(a); const y = read(b); return !!x && !!y && x.equals(y); };
function sameTree(a, b) {
  const fa = filesUnder(a); const fb = filesUnder(b);
  return fa.length === fb.length && fa.every((f, i) => f === fb[i] && sameBytes(path.join(a, f), path.join(b, f)));
}

// Backups live beside everything else, but Claude must never load an old copy as if it were live:
// .claude/ is stored as dot-claude/, and CLAUDE.md as CLAUDE (before update).md.
function backupRel(rel) {
  if (rel.startsWith('.claude/')) return `dot-claude/${rel.slice('.claude/'.length)}`;
  if (rel === 'CLAUDE.md') return 'CLAUDE (before update).md';
  return rel;
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function plan(src, dst) {
  const steps = []; // { op: 'replace'|'add', rel } for files; { op: 'skill', name, isNew } for skill folders
  for (const f of productFiles(src)) {
    const s = path.join(src, f.rel); const d = path.join(dst, f.rel);
    if (f.kind === 'if-missing') { if (!exists(d)) steps.push({ op: 'add', rel: f.rel }); continue; }
    if (!exists(d)) steps.push({ op: 'add', rel: f.rel });
    else if (!sameBytes(s, d)) steps.push({ op: 'replace', rel: f.rel });
  }
  for (const name of productSkills(src)) {
    const s = path.join(src, '.claude', 'skills', name); const d = path.join(dst, '.claude', 'skills', name);
    if (!isDir(d)) steps.push({ op: 'skill', name, isNew: true });
    else if (!sameTree(s, d)) steps.push({ op: 'skill', name, isNew: false });
  }
  for (const name of RETIRED_SKILLS) if (isDir(path.join(dst, '.claude', 'skills', name))) steps.push({ op: 'retire', name });
  return steps;
}

function copyFile(s, d) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
function copyTree(s, d) { for (const f of filesUnder(s)) copyFile(path.join(s, f), path.join(d, f)); }

function apply(src, dst, steps) {
  let backup = path.join(dst, `_before-update-${stamp()}`);
  for (let n = 2; exists(backup); n++) backup = path.join(dst, `_before-update-${stamp()}-${n}`);
  const toBackup = steps.filter((s) => s.op === 'replace' || (s.op === 'skill' && !s.isNew) || s.op === 'retire');
  if (toBackup.length) {
    for (const s of toBackup) {
      if (s.op === 'replace') copyFile(path.join(dst, s.rel), path.join(backup, backupRel(s.rel)));
      else copyTree(path.join(dst, '.claude', 'skills', s.name), path.join(backup, backupRel(`.claude/skills/${s.name}`)));
    }
    fs.writeFileSync(path.join(backup, 'README.txt'), `These are the files your AI Freedom Machine had before the update on ${new Date().toLocaleString()}.\nNothing here is used any more — it is only a safety copy. Your own files (keys, business profile,\nproduct, content, sales history) were never touched, so they are not in here.\nThe agents are in dot-claude/skills. You can delete this folder once everything works.\n`);
  }
  for (const s of steps) {
    if (s.op === 'replace' || s.op === 'add') copyFile(path.join(src, s.rel), path.join(dst, s.rel));
    else if (s.op === 'skill') {
      const d = path.join(dst, '.claude', 'skills', s.name);
      fs.rmSync(d, { recursive: true, force: true });
      copyTree(path.join(src, '.claude', 'skills', s.name), d);
    } else if (s.op === 'retire') fs.rmSync(path.join(dst, '.claude', 'skills', s.name), { recursive: true, force: true });
  }
  return toBackup.length ? backup : null;
}

// Commands run with the same node that runs this script. On a Mac the Claude app may not have
// /usr/local/bin (or Homebrew's /opt/homebrew/bin) on its PATH, and npm needs node on the PATH.
function childEnv() {
  const extra = [path.dirname(process.execPath)];
  if (process.platform === 'darwin') extra.push('/usr/local/bin', '/opt/homebrew/bin');
  // Windows spells it Path: set the key that is already there, never a second one beside it.
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...process.env, [key]: [...extra, process.env[key] || ''].join(path.delimiter), AIB_SCHEDULED: '' };
}
function npmInstall(dst) {
  // AIB_NPM_COMMAND replaces the npm command (the test suite points it at a stand-in).
  const cmd = process.env['AIB_NPM_COMMAND'] || 'npm install --no-audit --no-fund';
  // shell: Windows' own cmd.exe (ComSpec) when there is one, else the system shell.
  const r = spawnSync(cmd, { cwd: path.join(dst, 'system'), shell: process.env['ComSpec'] || true, encoding: 'utf8', env: childEnv(), timeout: 20 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = !r.error && r.status === 0;
  return { ok, tail: `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`.trim().split('\n').slice(-3).join('\n') };
}
function runNode(dst, args) {
  const r = spawnSync(process.execPath, [path.join(dst, 'system', args[0]), ...args.slice(1)], { cwd: dst, encoding: 'utf8', env: childEnv(), timeout: 5 * 60 * 1000 });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function recordHistory(dst, from, to, src) {
  const f = path.join(dst, 'system', '.state', 'update-history.json');
  let h = [];
  try { h = JSON.parse(fs.readFileSync(f, 'utf8')); if (!Array.isArray(h)) h = []; } catch (_) {}
  h.push({ from, to, at: new Date().toISOString(), source: src });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(h, null, 2));
}

function ownerItemsKept(dst) {
  const known = new Set(['system', '.claude', 'Product', 'Content', ...ROOT_FILES]);
  const theirs = [];
  try {
    for (const n of fs.readdirSync(dst)) {
      if (known.has(n) || /^_before-update-/.test(n) || /\.pdf$/i.test(n) || n === '.env' || n === 'client-config.md') continue;
      theirs.push(n);
    }
  } catch (_) {}
  return theirs;
}

function main() {
  const o = parseArgs(process.argv);
  const src = resolveSource(o.from);
  const dst = o.into ? resolveTarget(o.into) : null;
  if (!validate(src, dst)) return;

  const from = versionOf(dst); const to = versionOf(src);
  const steps = plan(src, dst);
  const files = steps.filter((s) => s.op === 'replace' || s.op === 'add');
  const skills = steps.filter((s) => s.op === 'skill');
  const theirs = ownerItemsKept(dst);
  const ownSkills = (() => { try { const prod = new Set(productSkills(src)); return fs.readdirSync(path.join(dst, '.claude', 'skills')).filter((n) => !prod.has(n) && !RETIRED_SKILLS.includes(n)); } catch (_) { return []; } })();

  const lines = [];
  lines.push(`${o.dryRun ? 'Update preview' : 'Update'}: your Machine folder ${dst}`);
  lines.push(`  from ${from} to ${to === from ? `${to} (the same version)` : to}`);
  if (!steps.length) lines.push('  Your program files and agents already match the new version — nothing to replace.');
  else {
    if (files.length) lines.push(`  ${o.dryRun ? 'Would update' : 'Updated'} ${files.length} program file(s)${files.some((f) => f.op === 'add') ? ` (${files.filter((f) => f.op === 'add').length} new)` : ''}.`);
    if (skills.length) lines.push(`  ${o.dryRun ? 'Would refresh' : 'Refreshed'} ${skills.length} agent(s)${skills.some((s) => s.isNew) ? `, including new: ${skills.filter((s) => s.isNew).map((s) => s.name).join(', ')}` : ''}.`);
  }
  lines.push(`  ${o.dryRun ? 'Will keep' : 'Kept'} exactly as they were: your keys (.env), your business profile (client-config.md), Product/, Content/, your sales history and saved settings (system/.state), your logs, your working hours${theirs.length ? `, and your own folders and files (${theirs.join(', ')})` : ''}${ownSkills.length ? `, and your own skills (${ownSkills.join(', ')})` : ''}.`);

  if (o.dryRun) {
    lines.push(`  ${steps.some((s) => s.op !== 'add' && !(s.op === 'skill' && s.isNew)) ? 'A backup of every file it replaces goes into a _before-update-… folder inside your Machine folder.' : 'Nothing would be replaced, so no backup is needed.'}`);
    lines.push('  Then: install the engine (npm install), re-register your scheduled jobs in this same folder, and run the health check.');
    lines.push('Nothing was changed (preview only).');
    console.log(lines.join('\n'));
    return;
  }

  const backup = steps.length ? apply(src, dst, steps) : null;
  if (backup) lines.push(`  Backup of the replaced files: ${path.basename(backup)} (inside your Machine folder — safe to delete once everything works).`);

  // The engine: only when the package list changed or it was never installed.
  let npmNote = null;
  const needNpm = steps.some((s) => /^system\/package(-lock)?\.json$/.test(s.rel || '')) || !exists(path.join(dst, 'system', 'node_modules'));
  if (!o.skipNpm && needNpm) {
    const r = npmInstall(dst);
    if (r.ok) lines.push('  Engine installed (npm install). ✅');
    else {
      npmNote = `⚠️  The engine install (npm install) didn't finish. The new files are all in place; the next step is to run, in the system folder:\n    ${process.platform === 'darwin' ? 'PATH="/usr/local/bin:$PATH" npm install' : 'npm install'}\n  (inside: ${path.join(dst, 'system')})${r.tail ? `\n  What npm said: ${r.tail}` : ''}`;
      process.exitCode = 1;
    }
  } else if (!o.skipNpm) lines.push('  Engine already up to date (no new packages).');

  if (!o.skipSchedule) {
    const r = runNode(dst, ['schedule-automation.js', 'reregister']);
    const say = r.out.split('\n').filter((l) => /All set|No saved automations|Removed the old-style|⚠️|Could not|Did not/.test(l));
    lines.push(`  Scheduled jobs re-registered in this same folder: ${say.length ? say.join(' ').trim() : (r.ok ? 'done' : 'see below')}${r.ok ? '' : `\n${r.out}`}`);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dst, 'system', '.state', 'scheduled-jobs.json'), 'utf8'));
      const old = ['content-write', 'content-render', 'content-reels', 'render-content', 'render-reels', 'auto-content'].filter((n) => (m.jobs || []).some((j) => j.name === n || j.script === `${n}.js`));
      if (old.length >= 2) lines.push('  Next (optional): your weekly content still runs as separate jobs — say "switch to the one-step weekly content job" so they run in order.');
    } catch (_) {}
  }
  if (steps.length) recordHistory(dst, from, to, src); // a re-run that changed nothing adds no entry
  if (npmNote) lines.push(npmNote);
  lines.push('Done. Start a NEW chat in this folder so your updated team loads.');
  console.log(lines.join('\n'));

  if (!o.skipHealth && !npmNote) {
    const h = runNode(dst, ['health-check.js']);
    console.log(`\nHealth check after the update:\n${h.out}`);
  }
}

module.exports = { editionOf, versionOf, resolveSource, plan, productFiles, productSkills, backupRel };
if (require.main === module) {
  try { main(); } catch (e) { console.log(`Update error: ${e.message}\nIf any files were already copied, running the same command again finishes the job safely.`); process.exitCode = 1; }
}
