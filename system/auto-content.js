// Auto-writer — the unattended weekly content planner (Auto-Pilot edition only).
// Reads the buyer's brand/audience from client-config, asks Claude to write a full week's
// content plan (all formats, in their voice), and saves it to Content/content-plan.json so the
// renderers + poster can take over. Needs ANTHROPIC_API_KEY in .env.
//
// Every item gets a posting DATE spread across the buyer's working days — the poster only posts
// what's due, so a week never goes out all at once. Last week's plan is archived to
// Content/history/ (never overwritten), and recent hooks are fed back in so openings don't repeat.
//
// If there's no key, it does nothing (the buyer plans content interactively instead).

const fs = require('fs');
const path = require('path');
const { ROOT, getConfigValue, getConfigSection } = require('./lib/config');
const { guardOrExit, loadWorkingHours, DAY_CODES, isScheduledRun, ranRecently, markRan } = require('./lib/working-hours');
const { askClaude, extractJson, hasKey } = require('./lib/anthropic');
const { lintItem } = require('./lib/copy-lint');
const { sendTelegram } = require('./lib/telegram');

const CONTENT_DIR = path.join(ROOT, 'Content');
const PLAN = path.join(CONTENT_DIR, 'content-plan.json');
const HISTORY_DIR = path.join(CONTENT_DIR, 'history');

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The buyer's working days over the next 7 days (today included), as YYYY-MM-DD.
function postingDays(now = new Date()) {
  let days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  try { days = loadWorkingHours().days; } catch (_) {}
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (days.includes(DAY_CODES[d.getDay()])) out.push(ymd(d));
  }
  return out.length ? out : [ymd(now)];
}

// Spread organic items evenly over the posting days; ads and talking scripts aren't feed posts.
function assignDates(plan, days) {
  const organic = plan.filter((it) => !['meta_ad', 'talking_reel'].includes(String(it.format).toLowerCase()));
  organic.forEach((it, i) => { it.date = days[Math.floor((i * days.length) / organic.length)] || days[0]; });
  for (const it of plan) if (!it.date) it.date = days[0];
  return plan;
}

// Backgrounds for the silent reels: video clips the owner drops in Content/clips/ (preferred),
// else photos in Content/images/, rotated in order across the week's reels so no two reels in a row
// share one. With neither folder (most buyers on day one) the renderer's layered brand gradient is
// used. Paths are stored relative to the business folder, the way the renderers expect them.
function listMedia(sub, re) {
  try { return fs.readdirSync(path.join(CONTENT_DIR, sub)).filter((f) => re.test(f) && !f.startsWith('.')).sort().map((f) => `Content/${sub}/${f}`); }
  catch (_) { return []; }
}
function assignBackgrounds(plan) {
  const clips = listMedia('clips', /\.(mp4|mov|m4v|webm)$/i);
  const images = listMedia('images', /\.(jpe?g|png|webp)$/i);
  const reels = plan.filter((it) => ['reel', 'silent_reel'].includes(String(it.format).toLowerCase()) && !it.background);
  // Start the rotation from a different point each week so the same clip isn't always reel 1.
  const offset = Math.floor(Date.now() / 6048e5);
  reels.forEach((it, i) => {
    if (clips.length) it.background = { type: 'clip', src: clips[(i + offset) % clips.length] };
    else if (images.length) it.background = { type: 'image', src: images[(i + offset) % images.length] };
  });
  return plan;
}

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; } }

// Openings used in the last ~4 weeks, so the writer can avoid them.
function recentHooks() {
  const files = [];
  if (fs.existsSync(HISTORY_DIR)) {
    for (const f of fs.readdirSync(HISTORY_DIR).filter((x) => x.endsWith('.json')).sort().slice(-4)) files.push(path.join(HISTORY_DIR, f));
  }
  files.push(PLAN);
  const hooks = [];
  for (const f of files) {
    for (const it of readJson(f, [])) {
      const h = it.headline || (Array.isArray(it.textStack) && it.textStack[0]) || (it.caption || '').split('\n')[0];
      if (h) hooks.push(String(h).slice(0, 90));
    }
  }
  return [...new Set(hooks)].slice(-40);
}

function archiveCurrentPlan() {
  const plan = readJson(PLAN, null);
  if (!Array.isArray(plan) || !plan.length) return;
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
  let out = path.join(HISTORY_DIR, `content-plan-${ymd(new Date())}.json`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(HISTORY_DIR, `content-plan-${ymd(new Date())}-${n}.json`);
  fs.writeFileSync(out, JSON.stringify(plan, null, 2));
  // Now that another week is in history, let go of media from plans archived over 8 weeks ago.
  try { require('./lib/prune-rendered').pruneRendered(); } catch (_) { /* tidying must never cost the week's plan */ }
}

function researchBlock() {
  // Fold in this week's research if content-research.js has run. Optional by design: without it the
  // plan is still written from the brand profile, it just isn't grounded in what's working right now.
  // Research older than ~3 weeks is dropped rather than trusted — stale trend data is worse than none.
  try {
    const rPath = path.join(CONTENT_DIR, 'research.json');
    if (!fs.existsSync(rPath)) return '';
    const r = JSON.parse(fs.readFileSync(rPath, 'utf8').replace(/^﻿/, ''));
    const ageDays = r.researchedOn ? (Date.now() - new Date(r.researchedOn)) / 864e5 : 0;
    if (ageDays > 21) {
      console.log(`(Research file is ${Math.round(ageDays)} days old — ignoring it and writing from the brand profile.)`);
      return '';
    }
    const list = (a, f) => (Array.isArray(a) ? a.slice(0, 8).map(f).filter(Boolean).join('\n') : '');
    return `
THIS WEEK'S RESEARCH (found ${r.researchedOn} — lean on this, it reflects what's landing right now)
Working now:
${list(r.workingNow, (x) => `- ${x.angle}: ${x.why}${x.example ? ` (e.g. "${x.example}")` : ''}`)}
Hook lines that are stopping scrolls:
${list(r.hooks, (h) => `- ${h}`)}
Formats that are working:
${list(r.formats, (x) => `- ${x.format}: ${x.note}`)}
AVOID — overused or stale right now:
${list(r.goingStale, (s) => `- ${s}`)}
${list(r.avoid, (s) => `- ${s}`)}
`;
  } catch (_) { return ''; /* malformed research file must never block the week's content */ }
}

// The owner's own steering files (all optional). Kept short so they never crowd out the brief.
function readText(rel, max = 2500) {
  try { return fs.readFileSync(path.join(CONTENT_DIR, rel), 'utf8').slice(0, max).trim(); } catch (_) { return ''; }
}
function ownerContext() {
  const feedback = readText('PERFORMANCE_FEEDBACK.md', 4000);
  // "PIN: …" lines (a bulleted "- PIN: …" counts too). Trimmed: a Windows-saved file ends each with \r.
  const PIN_LINE = /^[ \t]*(?:[-*•][ \t]*)?PIN:[ \t]*(.+)$/gim;
  const pins = [...feedback.matchAll(PIN_LINE)].map((m) => m[1].trim()).filter(Boolean);
  const ctas = getConfigSection('Content CTAs', '');
  return {
    story: readText('story-bank.md', 3000),
    ideas: readText('idea-bank.md', 3000),
    feedback: feedback.replace(PIN_LINE, '').trim(),
    pins,
    ctas,
  };
}

// Two batches so a full week can never be truncated mid-JSON (one big answer used to fail and cost
// the whole week). Each batch is independent: if one fails, the other still ships. Mostly reels —
// they're the discovery surface while an account is small (see the content playbook).
const BATCHES = [
  { key: 'reels', ask: '4 silent text-on-screen reels ("reel", textStack of 3-5 lines) and 1 talking-reel script ("talking_reel": a full TikTok/YouTube script of 70-90 words AND a short Instagram/Facebook cut of 40 words or fewer in "igCut")', formats: '"reel" | "talking_reel"' },
  { key: 'feed', ask: '2 single-image posts ("post" — these are also shared as image reels), 1 carousel of 5-7 slides, and 1 Meta ad ("meta_ad": ad headline + sub + primary text in caption; it is NOT posted to the feed)', formats: '"post" | "carousel" | "meta_ad"' },
];

const RULES = `RULES — follow every one:
HOOKS
- The first line / first on-screen line must stop the scroll ALONE: no warm-up, no greeting. On-screen hooks are 9 words or fewer.
- Across this batch use these hook shapes: at least one SELF-TEST ("You're doing X the hard way if…" / "If you've ever…"), at least one COLD TRUE NUMBER (a concrete, true count or time — NEVER money earned), and where the owner's story allows, one EXPERIENCE line taken ONLY from the story bank below. At most one plain "Here's how to…" opener.
- Concrete beats clever: small, physical, specific details ("47 tabs open") beat abstract advice ("stop overthinking").
- Lead with the payoff; the best line goes first.
LENGTH
- Silent reels: 3-5 on-screen lines, each under 12 words. Instagram/Facebook viewers leave fast — the whole thing should read in under 15 seconds.
- Talking reels: spoken lines are FULL natural sentences, never fragments. "script" = the 70-90 word TikTok/YouTube cut; "igCut" = 40 words or fewer with the payoff heard by second 6.
VALUE vs SELLING
- At least half of this batch is PURE VALUE: teaches something useful with no product mention; CTA = follow or save.
- At most ONE item in this batch may point to the product (a soft-sell). Pull, never push: open on the reader's moment, the product arrives late.
CAPTIONS
- Caption line 1 (45-70 characters) names the payoff or the moment. If the post teaches, the caption delivers the whole thing. Add one easy question to invite comments.
- At most 4 hashtags on Instagram/Facebook captions.
CALLS TO ACTION
- Exactly one CTA per piece. Only use a "comment WORD" CTA if WORD is listed in LIVE CTAS below, exactly as written. Otherwise use follow, save, or "link in bio".
HONESTY
- No income claims, earnings figures, "make $X", "passive income", "six figures", guarantees, or quit-your-job promises — anywhere, including on-screen text. Costs and time saved are fine.
- Never invent a story, result, client or testimonial. Experience lines come only from the story bank.
- Write real, specific, on-brand copy in the owner's voice — no placeholders.`;

function buildPrompt(batch = BATCHES[0], avoid = [], ctx = ownerContext()) {
  const audience = getConfigSection('Audience', 'their ideal customer');
  const voice = getConfigSection('Story / Voice', '') || getConfigSection('Voice', '');
  const product = getConfigSection('Product Topic', '') || getConfigValue('Name', '');
  const promise = getConfigSection('Transformation', '');
  const name = getConfigValue('Name', '');
  const block = (title, body) => (body ? `\n${title}:\n${body}\n` : '');

  return `You are a social media content strategist. Write part of ONE WEEK of content for this business.

PRODUCT NAME: ${name}
AUDIENCE:
${audience}
VOICE / STORY:
${voice}
PRODUCT:
${product}
PROMISE:
${promise}
${block('LIVE CTAS (the only comment keywords you may use, and what each one sends)', ctx.ctas || '(none — use follow, save or "link in bio")')}${block("THE OWNER'S STORY BANK (the only source for experience lines)", ctx.story)}${block('IDEA BANK (angles to draw from)', ctx.ideas)}${block('WHAT THE OWNER SAYS IS WORKING / NOT WORKING', ctx.feedback)}${ctx.pins.length ? `\nPINNED ANGLES — use each of these once this week if it fits this batch:\n${ctx.pins.map((p) => `- ${p}`).join('\n')}\n` : ''}${researchBlock()}
Write exactly: ${batch.ask}.
${avoid.length ? `\nDo NOT reuse or lightly reword these recent openings — find fresh angles:\n${avoid.map((h) => `- ${h}`).join('\n')}\n` : ''}
${RULES}

Return ONLY a JSON array. Each item must match this shape (use the fields relevant to its format):
{
  "id": "unique-short-id",
  "format": ${batch.formats},
  "platform": "instagram" | "facebook",
  "caption": "the caption to post with it (the owner's voice, relevant emojis, at most 4 hashtags)",
  "headline": "post/meta_ad: the big on-image line (9 words or fewer)",
  "sub": "post/meta_ad: smaller supporting line",
  "slides": [ {"kicker":"optional","title":"...","body":"..."} ],
  "textStack": ["hook (9 words or fewer)","line 2","line 3"],
  "script": "talking_reel: the full 70-90 word TikTok/YouTube script",
  "igCut": "talking_reel: the 40-word Instagram/Facebook cut",
  "angle": "value | story | soft-sell",
  "status": "planned"
}`;
}

async function writeBatch(batch, avoid, ctx) {
  const res = await askClaude(buildPrompt(batch, avoid, ctx), { maxTokens: 16000 });
  if (!res.ok) { console.log(`  ${batch.key}: could not write (${res.reason})${res.message ? ': ' + res.message : ''}`); return []; }
  let items = extractJson(res.text, 'array');
  // Tolerate {"items":[…]} wrappers and drop anything that isn't a content object.
  if (items && !Array.isArray(items)) items = Object.values(items).find(Array.isArray) || [];
  items = (items || []).filter((it) => it && typeof it === 'object' && !Array.isArray(it));
  if (!items.length) { console.log(`  ${batch.key}: no usable content came back${res.truncated ? ' (answer was cut off)' : ''}.`); return []; }
  return items;
}

// One automatic write per week. When a later step of the weekly job fails (say, the reels), the week
// isn't marked done, so the scheduler's catch-up runs over the next day or two start the chain again.
// Writing again there archived the plan written the day before (with its unposted items) and paid
// for a whole new week. So a SCHEDULED run skips writing when this writer already produced the
// current plan in the last 5 local calendar days (the same window as the weekly catch-up guard), and
// the later steps just render what's there. A run the owner asks for always writes, as before.
//
// Only a SCHEDULED write sets the mark: a week the owner wrote by hand on a Thursday (for a launch,
// say) used to count as "this week's write", so Monday's scheduled run skipped and the feed went
// quiet once those days were used up. And the mark alone isn't enough — the plan on disk also has
// to still have something ahead of it (an organic post not yet out, dated after today). A plan
// that's all used up, or was swapped for an old one, gets a fresh week.
const WRITE_MARK = 'content-write';
const NOT_FEED = ['meta_ad', 'talking_reel'];
const DONE = ['posted', 'skipped'];
function planDay(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}
function planCoversUpcomingDays(plan, now = new Date()) {
  const today = ymd(now);
  return plan.some((it) => it && typeof it === 'object'
    && !NOT_FEED.includes(String(it.format || '').toLowerCase())
    && !DONE.includes(String(it.status || '').toLowerCase())
    && planDay(it.date) && planDay(it.date) > today);
}
function alreadyWroteThisWeek(now = new Date()) {
  if (!isScheduledRun() || !ranRecently(WRITE_MARK, 5)) return false;
  const plan = readJson(PLAN, null);
  return Array.isArray(plan) && plan.length > 0 && planCoversUpcomingDays(plan, now);
}

// Returns what happened, so the weekly job can tell the owner the truth:
//   { wrote: n }  ·  { wrote: n, missing: ['reels'] } (one batch didn't come back)
//   { skipped: 'no-key' }  ·  { skipped: 'already-written' }  ·  { failed: true }
// Batches the owner can ask for by name ("write this week's reels" -> --only reels).
const ONLY_KEYS = { reels: 'reels', reel: 'reels', posts: 'feed', post: 'feed', feed: 'feed' };

// Which batch(es) of this week's plan didn't come through, so a later run (the weekly catch-up, or
// the owner's "write this week's reels") can say so and clear it. Lives in system/.state.
const MISSING_FILE = path.join(__dirname, '.state', 'content-missing.json');
function readMissing() {
  const m = readJson(MISSING_FILE, null);
  // Only for the plan it was written about: a newer week makes an old reminder meaningless.
  if (!m || !Array.isArray(m.missing) || !m.missing.length || (Date.now() - (m.at || 0)) > 8 * 864e5) return [];
  return m.missing.filter((k) => BATCHES.some((b) => b.key === k));
}
function writeMissing(missing) {
  try {
    if (!missing.length) { fs.rmSync(MISSING_FILE, { force: true }); return; }
    fs.mkdirSync(path.dirname(MISSING_FILE), { recursive: true });
    fs.writeFileSync(MISSING_FILE, JSON.stringify({ missing, at: Date.now() }, null, 2));
  } catch (_) { /* a reminder must never fail the writer */ }
}

// Ids unique across the plan (renders are saved by id, so a clash would overwrite an image), every
// item "planned", then the copy lint: trim hashtags and HOLD anything that reads like an earnings
// claim or uses one of the owner's banned words. Held items are never rendered or posted until the
// owner reviews them with their assistant. Returns the held summaries.
function prepareItems(items, used = new Set()) {
  items.forEach((it, i) => {
    let id = String(it.id || `item-${i + 1}`).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || `item-${i + 1}`;
    while (used.has(`${ymd(new Date())}-${id}`)) id += '-b';
    it.id = `${ymd(new Date())}-${id}`;
    used.add(it.id);
    it.status = 'planned';
  });
  const held = [];
  for (const it of items) {
    const { fixes, problems } = lintItem(it);
    if (fixes.length) it.notes = fixes;
    if (problems.length) { it.status = 'needs-review'; it.review = problems; held.push(`${it.format} "${String(it.headline || (it.textStack || [])[0] || it.caption || '').slice(0, 40)}" — ${problems.join(', ')}`); }
  }
  return held;
}

async function tellHeld(held) {
  if (!held.length) return;
  const msg = `✋ ${held.length} of this week's posts are on hold for a quick look before they can go out:\n${held.slice(0, 5).join('\n')}\n\nOpen your assistant and say "review my held posts".`;
  console.log(msg);
  await sendTelegram(msg);
}

// "write this week's reels" (--only reels) / "…posts" (--only posts): writes just that batch and
// ADDS it to the current plan — nothing is archived or replaced, and every item already there keeps
// its id and status (a rendered or posted item is never touched).
async function writeOnly(key) {
  const batch = BATCHES.find((b) => b.key === key);
  console.log(`Writing this week's ${batchWords(key)} with Claude (adding them to your current plan)...`);
  const items = await writeBatch(batch, recentHooks(), ownerContext());
  if (!items.length) { console.log(`Claude did not return usable ${batchWords(key)} this time — nothing was changed. Try again in a few minutes.`); process.exitCode = 1; return { failed: true, only: key }; }
  const current = readJson(PLAN, []);
  const plan = Array.isArray(current) ? current : [];
  const held = prepareItems(items, new Set(plan.map((it) => it && String(it.id))));
  assignDates(items, postingDays());
  assignBackgrounds(items);
  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
  const tmp = PLAN + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(plan.concat(items), null, 2));
  fs.renameSync(tmp, PLAN);
  writeMissing(readMissing().filter((k) => k !== key));
  console.log(`Added ${items.length} ${batchWords(key)} to Content/content-plan.json (everything already in it was kept). Rendering them now...`);
  // Render the new items right away (only "planned" items are picked up, so nothing already rendered
  // is touched). The renderer sets process.exitCode on a failure; that is read, then reset.
  const renderer = key === 'reels' ? 'render-reels' : 'render-content';
  let rendered = null; let renderNote;
  const prevExit = process.exitCode; process.exitCode = 0;
  try {
    rendered = await require(`./${renderer}`).run();
    renderNote = process.exitCode === 1
      ? `rendering hit a snag${rendered && rendered.failed ? ` (${rendered.failed} didn't render)` : ''} — say "render my content" to try again`
      : `rendered${rendered && Number.isFinite(rendered.rendered) ? ` ${rendered.rendered}` : ''}`;
  } catch (e) { renderNote = `couldn't render them yet (${e.message}) — next: node system/${renderer}.js`; process.exitCode = 1; }
  if (process.exitCode !== 1) process.exitCode = prevExit;
  console.log(`Done — added ${items.length} ${batchWords(key)}; ${renderNote}. ${process.exitCode === 1 ? '⚠️' : '✅'}`);
  await tellHeld(held);
  return { wrote: items.length, only: key, merged: true, rendered: rendered && rendered.rendered, renderFailed: process.exitCode === 1 };
}

async function run({ only } = {}) {
  // Working hours are for the scheduled job. Something the owner asks for ("write this week's
  // reels", a hand-run) must work at any hour, so only a scheduled run is held to them.
  if (isScheduledRun()) guardOrExit('auto-content');
  if (!hasKey()) {
    console.log('Auto-writer is off (no ANTHROPIC_API_KEY in .env). Plan content in a session instead, or add a key to enable weekly auto-writing.');
    return { skipped: 'no-key' };
  }
  if (only !== undefined) {
    const key = ONLY_KEYS[String(only || '').toLowerCase()];
    if (!key) { console.log('--only must be "reels" or "posts".'); process.exitCode = 1; return { failed: true }; }
    return writeOnly(key);
  }
  if (alreadyWroteThisWeek()) {
    console.log('This week\'s plan was already written in the last few days — keeping it and skipping the writing step. (This is normal and safe.)');
    return { skipped: 'already-written' };
  }
  console.log('Writing this week\'s content plan with Claude...');
  const avoid = recentHooks();
  const ctx = ownerContext();
  let plan = [];
  const missing = [];
  for (const batch of BATCHES) {
    const items = await writeBatch(batch, avoid, ctx);
    if (!items.length) missing.push(batch.key);
    plan = plan.concat(items);
  }
  if (!plan.length) { console.log('Claude did not return a usable plan this time. Will try next run.'); process.exitCode = 1; return { failed: true }; }

  const held = prepareItems(plan);
  assignDates(plan, postingDays());
  assignBackgrounds(plan);

  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
  archiveCurrentPlan();
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2));
  // The weekly mark is set by the scheduled job and by the weekly chain (weekly-content.js sets
  // AIB_IN_CHAIN), including a chain the owner started by hand — that IS this week's write. Only a
  // standalone hand-run of this file (an extra week written on request) leaves it alone.
  if (isScheduledRun() || String(process.env.AIB_IN_CHAIN || '') === '1') markRan(WRITE_MARK); // see alreadyWroteThisWeek
  writeMissing(missing);
  console.log(`Done — wrote ${plan.length} content items to Content/content-plan.json (last week's plan saved in Content/history). ${missing.length ? '⚠️' : '✅'}`);
  if (missing.length) console.log(`Not written this time: the ${missing.map(batchWords).join(' and the ')} batch — ${missingFix(missing)} (${missing.map((k) => `node system/auto-content.js --only ${batchWords(k)}`).join(', then ')}).`);
  await tellHeld(held);
  return missing.length ? { wrote: plan.length, missing } : { wrote: plan.length };
}

// How each batch is named to the owner ("the reels batch didn't come through"), and the words
// that finish it — the content creator runs "node system/auto-content.js --only reels" for them.
function batchWords(key) { return key === 'feed' ? 'posts' : key; }
function missingFix(missing) { return missing.map((k) => `say "write this week's ${batchWords(k)}"`).join(' and ') + ` to finish ${missing.length === 1 ? 'it' : 'them'}`; }

module.exports = { run, buildPrompt, assignDates, postingDays, ownerContext, assignBackgrounds, alreadyWroteThisWeek, planCoversUpcomingDays, batchWords, missingFix, readMissing, BATCHES };

if (require.main === module) {
  // --only reels | --only posts: write just that batch and add it to the current plan.
  const i = process.argv.indexOf('--only');
  run(i > -1 ? { only: process.argv[i + 1] || '' } : {}).catch((e) => { console.log(`Auto-writer error: ${e.message}`); process.exitCode = 1; });
}
