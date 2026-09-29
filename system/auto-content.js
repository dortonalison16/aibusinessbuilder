// Auto-writer — the unattended weekly content planner (Automated version only).
// Reads the buyer's brand/audience from client-config, asks Claude to write a full week's
// content plan (all formats, in their voice), and saves it to Content/content-plan.json so the
// renderers + poster can take over. Needs ANTHROPIC_API_KEY in .env.
//
// If there's no key, it does nothing (the buyer plans content interactively instead).

const fs = require('fs');
const path = require('path');
const { ROOT, getConfigValue } = require('./lib/config');
const { guardOrExit } = require('./lib/working-hours');
const { askClaude, extractJson, hasKey } = require('./lib/anthropic');

const CONTENT_DIR = path.join(ROOT, 'Content');
const PLAN = path.join(CONTENT_DIR, 'content-plan.json');

function buildPrompt() {
  const audience = getConfigValue('Audience', 'their ideal customer');
  const voiceBlock = getConfigValue('Story / Voice', '') || getConfigValue('Voice', '');
  const product = getConfigValue('Product Topic', '') || getConfigValue('Name', '');
  const promise = getConfigValue('Transformation', '');
  const brand = getConfigValue('Brand & Look', '');

  // Fold in this week's research if content-research.js has run. Optional by design: without it the
  // plan is still written from the brand profile, it just isn't grounded in what's working right now.
  // Research older than ~3 weeks is dropped rather than trusted — stale trend data is worse than none.
  let researchBlock = '';
  try {
    const rPath = path.join(CONTENT_DIR, 'research.json');
    if (fs.existsSync(rPath)) {
      const r = JSON.parse(fs.readFileSync(rPath, 'utf8'));
      const ageDays = r.researchedOn ? (Date.now() - new Date(r.researchedOn)) / 864e5 : 0;
      if (ageDays <= 21) {
        const list = (a, f) => (Array.isArray(a) ? a.slice(0, 8).map(f).filter(Boolean).join('\n') : '');
        researchBlock = `
THIS WEEK'S RESEARCH (found ${r.researchedOn} — lean on this, it reflects what's landing right now)
Working now:
${list(r.workingNow, (x) => `- ${x.angle}: ${x.why}${x.example ? ` (e.g. "${x.example}")` : ''}`)}
Hook lines that are stopping scrolls:
${list(r.hooks, (h) => `- ${h}`)}
Formats that suit a faceless brand:
${list(r.formats, (x) => `- ${x.format}: ${x.note}`)}
AVOID — overused or stale right now:
${list(r.goingStale, (s) => `- ${s}`)}
${list(r.avoid, (s) => `- ${s}`)}
`;
      } else {
        console.log(`(Research file is ${Math.round(ageDays)} days old — ignoring it and writing from the brand profile.)`);
      }
    }
  } catch (_) { /* malformed research file must never block the week's content */ }

  return `You are a social media content strategist. Write ONE WEEK of content for this business.

AUDIENCE: ${audience}
VOICE / STORY: ${voiceBlock}
PRODUCT: ${product}
PROMISE: ${promise}
BRAND LOOK: ${brand}
${researchBlock}
Produce a balanced week: a few posts, 1-2 carousels, a couple of stories, 1 silent reel, 1 talking-reel script, and 1 meta ad. Include ONE soft-sell that points to the product.

Return ONLY a JSON array. Each item must match this shape (use the fields relevant to its format):
{
  "id": "unique-short-id",
  "format": "post" | "carousel" | "story" | "reel" | "talking_reel" | "meta_ad",
  "platform": "instagram" | "facebook",
  "caption": "the caption to post with it (in their voice, with relevant emojis)",
  "headline": "for post/story: the big on-image line",
  "sub": "for post/story: smaller supporting line",
  "slides": [ {"kicker":"optional","title":"...","body":"..."} ],            // carousels only
  "textStack": ["line 1","line 2","line 3"],                                  // reel: accumulating lines
  "script": "for talking_reel: the full word-for-word spoken script",
  "status": "planned"
}
Write real, specific, on-brand copy — no placeholders. Keep it honest (no income guarantees).`;
}

async function run() {
  guardOrExit('auto-content');
  if (!hasKey()) {
    console.log('Auto-writer is off (no ANTHROPIC_API_KEY in .env). Plan content in a session instead, or add a key to enable weekly auto-writing.');
    return;
  }
  console.log('Writing this week\'s content plan with Claude...');
  const res = await askClaude(buildPrompt(), { maxTokens: 6000 });
  if (!res.ok) { console.log(`Could not write content (${res.reason})${res.message ? ': ' + res.message : ''}. Will try next run.`); return; }
  const plan = extractJson(res.text);
  if (!Array.isArray(plan) || !plan.length) { console.log('Claude did not return a usable plan this time. Will try next run.'); return; }

  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
  plan.forEach((it) => { if (!it.status) it.status = 'planned'; });
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2));
  console.log(`Done — wrote ${plan.length} content items to Content/content-plan.json. ✅ Next: render-content + render-reels, then social-post.`);
}

module.exports = { run, buildPrompt };

if (require.main === module) {
  run().catch((e) => { console.log(`Auto-writer error: ${e.message}`); process.exitCode = 1; });
}
