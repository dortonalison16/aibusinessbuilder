// Renders the visual media for a weekly content plan.
//   Content/content-plan.json  ->  Content/rendered/<id>-*.png  (+ updates the plan with mediaPaths)
//
// Handles image formats now (post, carousel, story). Silent-reel VIDEO rendering is a separate
// step (render-reels.js, ffmpeg). Talking-reel scripts + meta-ad copy are text — no render needed.

const fs = require('fs');
const path = require('path');
const { ROOT, getConfigValue } = require('./lib/config');
const { renderHtmlToPng } = require('./lib/render-image');
const tpl = require('./lib/templates');

const CONTENT_DIR = path.join(ROOT, 'Content');
const PLAN = path.join(CONTENT_DIR, 'content-plan.json');
const OUT_DIR = path.join(CONTENT_DIR, 'rendered');

// Pull a brand palette from client-config if present, else defaults.
function brandFromConfig() {
  const palette = getConfigValue('Brand & Look', '') || '';
  const hexes = (palette.match(/#[0-9a-fA-F]{6}/g) || []);
  const b = { ...tpl.DEFAULT_BRAND };
  if (hexes[0]) b.primary = hexes[0];
  if (hexes[1]) b.accent = hexes[1];
  return b;
}

function loadPlan() {
  try { return JSON.parse(fs.readFileSync(PLAN, 'utf8')); } catch (_) { return []; }
}
function savePlan(p) { fs.writeFileSync(PLAN, JSON.stringify(p, null, 2)); }

async function renderItem(item, brand) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const media = [];
  const fmt = (item.format || 'post').toLowerCase();

  if (fmt === 'post' || fmt === 'meta_ad') {
    const out = path.join(OUT_DIR, `${item.id}.png`);
    await renderHtmlToPng({ html: tpl.postImage({ headline: item.headline || item.caption, sub: item.sub, brand }), width: 1080, height: 1080, outPath: out });
    media.push(out);
  } else if (fmt === 'carousel') {
    const slides = item.slides || [];
    for (let i = 0; i < slides.length; i++) {
      const out = path.join(OUT_DIR, `${item.id}-slide-${i + 1}.png`);
      await renderHtmlToPng({
        html: tpl.carouselSlide({ ...slides[i], index: i + 1, total: slides.length, brand }),
        width: 1080, height: 1080, outPath: out,
      });
      media.push(out);
    }
  } else if (fmt === 'story') {
    const out = path.join(OUT_DIR, `${item.id}.png`);
    await renderHtmlToPng({ html: tpl.story({ headline: item.headline || item.caption, sub: item.sub, brand }), width: 1080, height: 1920, outPath: out });
    media.push(out);
  } else {
    // silent_reel (video -> render-reels.js), talking_reel (script) — nothing to image-render here.
    return { skipped: true };
  }
  return { media };
}

async function run() {
  const plan = loadPlan();
  if (!plan.length) { console.log('No content plan found (Content/content-plan.json). Make one with the content creator.'); return; }
  const brand = brandFromConfig();

  let rendered = 0;
  for (const item of plan) {
    if (item.status && item.status !== 'planned' && item.status !== 'pending') continue;
    const res = await renderItem(item, brand);
    if (res.skipped) continue;
    item.mediaPaths = res.media;
    item.status = 'rendered';
    rendered++;
    console.log(`Rendered ${item.format} "${(item.caption || item.headline || item.id).toString().slice(0, 40)}" -> ${res.media.length} file(s)`);
  }
  savePlan(plan);
  console.log(rendered ? `Done — rendered ${rendered} item(s) into Content/rendered. ✅` : 'Nothing new to render. ✅');
}

module.exports = { run, renderItem, brandFromConfig };

if (require.main === module) {
  run().catch((e) => { console.log(`Render error: ${e.message}`); process.exitCode = 1; });
}
