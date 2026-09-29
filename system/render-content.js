// Renders the visual media for a weekly content plan.
//   Content/content-plan.json  ->  Content/rendered/<id>-*.png  (+ updates the plan with mediaPaths)
//
// Handles image formats (post, carousel, story, meta_ad). Silent-reel VIDEO rendering is a separate
// step (render-reels.js, ffmpeg). Talking-reel scripts are text — no render needed.
// Meta ads render at 4:5 (1080x1350) and are ALSO dropped into Content/ads/ready/ with their copy,
// ready for meta-ads.js upload (paused) — they are never posted to the organic feed.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./lib/config');
const { brandFromConfig: brandFrom } = require('./lib/brand');
const { renderHtmlToPng, loadPuppeteer } = require('./lib/render-image');
const tpl = require('./lib/templates');
const { scrimFor } = require('./lib/photo-scrim');

const CONTENT_DIR = path.join(ROOT, 'Content');
const IMAGES_DIR = path.join(CONTENT_DIR, 'images');
const PLAN = path.join(CONTENT_DIR, 'content-plan.json');
const OUT_DIR = path.join(CONTENT_DIR, 'rendered');

// Pull a brand palette from client-config (hex codes or plain color words), else defaults.
function brandFromConfig() { return brandFrom(tpl.DEFAULT_BRAND); }

// The on-image line: the headline, or failing that the first sentence of the caption — never the
// whole caption, which overflows the frame.
function headlineOf(item) {
  if (item.headline) return item.headline;
  const first = String(item.caption || '').split(/\n|(?<=[.!?])\s/)[0].trim();
  return first.length > 90 ? first.slice(0, 87).replace(/\s+\S*$/, '') + '…' : first;
}

// The small eyebrow line above the hook. The writer may set item.kicker; otherwise the angle names
// it (value → a tip, story → real talk, soft-sell → the business name), so every frame carries the
// same editorial chrome without the copy having to change.
function kickerOf(item, brand) {
  if (item.kicker) return String(item.kicker);
  const angle = String(item.angle || '').toLowerCase();
  if (angle === 'value') return 'Quick tip';
  if (angle === 'story') return 'Real talk';
  return brand.name || '';
}

// Photos the owner drops in Content/images/ become post/story/ad backgrounds (under a brand-tinted
// scrim). Rotated by a stable hash of the item id, so a re-render draws the same picture. With no
// images (most buyers on day one) the layered brand gradient is used.
function listImages() {
  try { return fs.readdirSync(IMAGES_DIR).filter((f) => /.(jpe?g|png|webp)$/i.test(f) && !f.startsWith('.')).sort().map((f) => path.join(IMAGES_DIR, f)); }
  catch (_) { return []; }
}
function hashOf(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function backgroundOf(item, images) {
  const bg = item.background || {};
  if (bg.type === 'image' && bg.src) return path.isAbsolute(bg.src) ? bg.src : path.join(ROOT, bg.src);
  if (bg.type === 'none' || bg.type === 'gradient') return '';
  return images.length ? images[hashOf(item.id) % images.length] : '';
}

// Ad creatives also go to Content/ads/ready/ with a copy sidecar in the exact format meta-ads.js
// upload reads — so "make an ad" and "upload the ad" connect with no manual file shuffling.
function stageAd(item, pngPath) {
  const dir = path.join(CONTENT_DIR, 'ads', 'ready');
  fs.mkdirSync(dir, { recursive: true });
  const base = String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  fs.copyFileSync(pngPath, path.join(dir, base + '.png'));
  // Headline/description are single lines in the copy file — a stray newline would split them.
  const one = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();
  const copy = [`HEADLINE: ${one(headlineOf(item))}`, `DESCRIPTION: ${one(item.sub)}`, '---', item.caption || ''].join('\n');
  fs.writeFileSync(path.join(dir, base + '.txt'), copy);
}

// Shared merge-save (lib/plan): a save here can never un-post an item the poster published meanwhile.
const { loadPlan, savePlan, toPlanPath } = require('./lib/plan');

async function renderItem(item, brand, browser, images = listImages()) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const media = [];
  const fmt = (item.format || 'post').toLowerCase();
  const kicker = kickerOf(item, brand);
  const background = backgroundOf(item, images);
  const seed = hashOf(item.id);
  // How hard the photo needs holding back under white copy (lib/photo-scrim) — measured once per
  // picture and frame shape, so a bright photo gets a real scrim and a dark one keeps itself.
  const scrimAt = (width, height) => scrimFor(background, browser, { width, height });

  if (fmt === 'post') {
    const out = path.join(OUT_DIR, `${item.id}.png`);
    await renderHtmlToPng({ html: tpl.postImage({ headline: headlineOf(item), sub: item.sub, kicker, brand, background, seed, scrim: await scrimAt(1080, 1080) }), width: 1080, height: 1080, outPath: out }, browser);
    media.push(out);
  } else if (fmt === 'meta_ad') {
    const out = path.join(OUT_DIR, `${item.id}.png`);
    await renderHtmlToPng({ html: tpl.postImage({ headline: headlineOf(item), sub: item.sub, kicker, cta: item.cta || 'Learn more', brand, background, seed, height: 1350, scrim: await scrimAt(1080, 1350) }), width: 1080, height: 1350, outPath: out }, browser);
    media.push(out);
    stageAd(item, out);
  } else if (fmt === 'carousel') {
    const slides = item.slides || [];
    const scrim = await scrimAt(1080, 1080);
    for (let i = 0; i < slides.length; i++) {
      const out = path.join(OUT_DIR, `${item.id}-slide-${i + 1}.png`);
      await renderHtmlToPng({
        html: tpl.carouselSlide({ ...slides[i], index: i + 1, total: slides.length, brand, background, scrim }),
        width: 1080, height: 1080, outPath: out,
      }, browser);
      media.push(out);
    }
  } else if (fmt === 'story') {
    const out = path.join(OUT_DIR, `${item.id}.png`);
    await renderHtmlToPng({ html: tpl.story({ headline: headlineOf(item), sub: item.sub, kicker, brand, background, seed, scrim: await scrimAt(1080, 1920) }), width: 1080, height: 1920, outPath: out }, browser);
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
  const todo = plan.filter((it) => (!it.status || it.status === 'planned' || it.status === 'pending')
    && ['post', 'carousel', 'story', 'meta_ad'].includes(String(it.format || 'post').toLowerCase()));
  if (!todo.length) { console.log('Nothing new to render. ✅'); return; }
  try { require('./lib/prune-rendered').pruneRendered(); } catch (_) { /* tidying must never block a render */ }

  // One browser for the whole batch (launching Chrome per image was slow and flaky).
  const browser = await loadPuppeteer().launch({ headless: 'new', args: ['--no-sandbox'] });
  let rendered = 0, failed = 0;
  const images = listImages();
  if (images.length) console.log(`Using ${images.length} photo(s) from Content/images as backgrounds.`);
  try {
    for (const item of todo) {
      try {
        const res = await renderItem(item, brand, browser, images);
        if (res.skipped) continue;
        if (!res.media.length) throw new Error('nothing to draw (a carousel needs "slides")');
        item.mediaPaths = res.media.map(toPlanPath); // relative to the business folder (lib/plan)
        item.status = 'rendered';
        delete item.error;
        rendered++;
        console.log(`Rendered ${item.format} "${(item.headline || item.caption || item.id).toString().slice(0, 40)}" -> ${res.media.length} file(s)`);
      } catch (e) {
        // One bad item must never cost the rest of the week.
        failed++;
        item.error = `render failed: ${e.message}`;
        console.log(`Could not render ${item.id}: ${e.message}`);
      }
      savePlan(plan);
    }
  } finally { await browser.close(); }
  console.log(`Done — rendered ${rendered} item(s) into Content/rendered${failed ? `, ${failed} failed (see "error" in the plan — they'll be tried again next run). ⚠️` : '. ✅'}`);
  // Any failure counts, even when others rendered: the weekly job then reports the step and leaves
  // the week unmarked, so its catch-up run renders just the items still waiting (status "planned").
  if (failed) process.exitCode = 1;
  return { rendered, failed };
}

module.exports = { run, renderItem, brandFromConfig };

if (require.main === module) {
  run().catch((e) => { console.log(`Render error: ${e.message}`); process.exitCode = 1; });
}
