// Weekly content research (Automated version only).
//
//   node system/content-research.js
//
// Looks up what's actually working RIGHT NOW in the buyer's niche — angles, hooks, formats, and
// what's gone stale — and saves it to Content/research.json. The auto-writer reads that file on its
// next run, so the week's content is grounded in current reality instead of only the brand profile.
//
// Uses Claude's built-in web search via the buyer's existing ANTHROPIC_API_KEY. No scraping vendor,
// no second subscription, nothing extra to install. If there's no key it exits quietly — the buyer
// just plans content interactively instead, exactly as before.
//
// Schedule it to run BEFORE the writer:
//   node system/schedule-automation.js add --name content-research --script content-research.js --freq weekly --day Sun
//   node system/schedule-automation.js add --name content-write    --script auto-content.js     --freq weekly --day Mon

const fs = require('fs');
const path = require('path');
const { ROOT, getConfigValue } = require('./lib/config');
const { guardOrExit } = require('./lib/working-hours');
const { askClaude, extractJson, hasKey } = require('./lib/anthropic');

const CONTENT_DIR = path.join(ROOT, 'Content');
const OUT = path.join(CONTENT_DIR, 'research.json');

function buildPrompt() {
  const audience = getConfigValue('Audience', '');
  const product = getConfigValue('Product Topic', '') || getConfigValue('Name', '');
  const promise = getConfigValue('Transformation', '');
  const niche = [product, audience].filter(Boolean).join(' for ');

  return `You are a content strategist doing this week's research for a faceless digital-product business.

THE BUSINESS
- Sells: ${product || '(not set yet)'}
- Audience: ${audience || '(not set yet)'}
- Promise: ${promise || '(not set yet)'}

Search the web for what is working in short-form social content RIGHT NOW for this niche${niche ? ` (${niche})` : ''}.
Look for recent posts, formats and angles — prioritise the last 30-60 days. Then answer honestly,
including where something has gone stale.

Return ONLY valid JSON in exactly this shape, no commentary:

{
  "researchedOn": "YYYY-MM-DD",
  "workingNow": [
    { "angle": "short name", "why": "one sentence on why it's landing right now", "example": "a concrete hook or opening line in this style" }
  ],
  "goingStale": [ "format or angle that's overused right now, and why" ],
  "hooks": [ "5-8 specific opening lines that would stop a scroll for THIS audience" ],
  "formats": [ { "format": "e.g. text-over-broll list", "note": "why it suits a faceless brand" } ],
  "avoid": [ "anything that reads as spam, breaks platform rules, or is overdone" ],
  "sources": [ "brief note of what you found, one line each" ]
}

RULES — these matter more than being impressive:
- NO income claims, earnings figures, or "make $X" angles. Ever. They get accounts banned and they aren't honest.
- Nothing requiring the owner's face or voice on camera — this is a faceless brand.
- Specific over clever. "The 10pm laptop moment" beats "relatable content".
- If the search turns up little for this niche, say so in "sources" rather than inventing trends.
  An honest empty result is far more useful than a confident fabrication.`;
}

async function run() {
  guardOrExit('content-research');

  if (!hasKey()) {
    console.log('No ANTHROPIC_API_KEY in .env — skipping research.');
    console.log('(Nothing breaks: you can plan content with your assistant interactively instead.)');
    return;
  }

  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });

  console.log('Researching what\'s working in your niche right now…');
  const res = await askClaude(buildPrompt(), { search: true, maxSearches: 6, maxTokens: 6000 });

  if (!res.ok) {
    console.log(`Research skipped (${res.reason}${res.message ? ': ' + res.message : ''}). Your content plan will still be written from your brand profile.`);
    return;
  }

  const data = extractJson(res.text);
  if (!data) {
    console.log('Could not read the research response as JSON — leaving the previous research file alone.');
    return;
  }

  // Stamp it so the writer can tell how fresh this is, and so stale research is obvious.
  data.researchedOn = data.researchedOn || new Date().toISOString().slice(0, 10);
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));

  const n = (k) => (Array.isArray(data[k]) ? data[k].length : 0);
  console.log(`\n✓ Saved Content/research.json`);
  console.log(`  ${n('workingNow')} angles working now · ${n('hooks')} hooks · ${n('formats')} formats · ${n('goingStale')} going stale`);
  console.log('  The content writer will use this on its next run.');
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => console.log(`Research hit an error (will retry next run): ${err.message}`));
}
