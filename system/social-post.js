// Auto-posts the rendered content plan to Facebook/Instagram.
//
// SAFETY: ships in DRY-RUN by default — only logs what it WOULD post until the buyer sets
// SOCIAL_DRY_RUN=false in .env. Works off Content/content-plan.json (the same file the writer
// and renderers use): posts items that are RENDERED and due, then marks them posted.
//
// Instagram needs a public image URL, so local rendered images are hosted first (IMGBB_API_KEY).
// Facebook can post by hosted URL too. Carousels (multi-image) and video reels need multi-part /
// video publishing — flagged as manual for now (rendering is done; those API flows are heavier).

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./lib/config');
const { guardOrExit } = require('./lib/working-hours');
const { sendTelegram, loadEnv } = require('./lib/telegram');
const meta = require('./lib/meta');
const { hostImage } = require('./lib/host-image');

const PLAN = path.join(ROOT, 'Content', 'content-plan.json');

function loadPlan() { try { return JSON.parse(fs.readFileSync(PLAN, 'utf8')); } catch (_) { return []; } }
function savePlan(p) { fs.writeFileSync(PLAN, JSON.stringify(p, null, 2)); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

const SINGLE_IMAGE = ['post', 'story', 'meta_ad'];

// Host every local image and return public URLs (needed for Instagram). Returns null on any failure.
async function hostAll(paths, env) {
  const urls = [];
  for (const p of paths) { const h = await hostImage(p, env); if (!h.ok) return null; urls.push(h.url); }
  return urls;
}

async function postItem(item, env) {
  const platform = (item.platform || 'facebook').toLowerCase();
  const fmt = (item.format || 'post').toLowerCase();
  const media = item.mediaPaths || [];

  if (fmt === 'talking_reel') return { ok: false, manual: true, why: 'talking reel is a script to film — not auto-posted' };

  // ── Carousel (multi-image) ──
  if (fmt === 'carousel') {
    if (!media.length) return { ok: false, why: 'no rendered slides' };
    if (platform === 'instagram') {
      const urls = await hostAll(media, env);
      if (!urls) return { ok: false, why: 'could not host carousel images for IG (check IMGBB_API_KEY)' };
      return meta.postInstagramCarousel({ imageUrls: urls, caption: item.caption }, env);
    }
    return meta.postFacebookMultiPhoto({ imagePaths: media, caption: item.caption }, env); // FB uploads locals
  }

  // ── Video reel ──
  if (fmt === 'reel' || fmt === 'silent_reel') {
    if (!media[0]) return { ok: false, why: 'no rendered video' };
    if (platform === 'instagram') {
      // IG reels require a PUBLIC video URL; imgbb hosts images only. Needs video hosting.
      if (item.videoUrl) return meta.postInstagramReel({ videoUrl: item.videoUrl, caption: item.caption }, env);
      return { ok: false, manual: true, why: 'IG reel needs a public video URL (video hosting) — post manually for now' };
    }
    return meta.postFacebookVideo({ videoPath: media[0], caption: item.caption }, env); // FB uploads the local MP4
  }

  // ── Single image (post / story / meta_ad) ──
  let imageUrl = null;
  if (SINGLE_IMAGE.includes(fmt) && media[0]) {
    const h = await hostImage(media[0], env);
    if (!h.ok && platform === 'instagram') return { ok: false, why: `couldn't host image for IG (${h.reason})` };
    imageUrl = h.ok ? h.url : null;
  }
  if (platform === 'instagram') {
    if (!imageUrl) return { ok: false, why: 'no hosted image URL for Instagram' };
    return meta.postInstagramPhoto({ imageUrl, caption: item.caption }, env);
  }
  if (imageUrl) return meta.postFacebookPhoto({ imageUrl, caption: item.caption }, env);
  return meta.postFacebookText({ message: item.caption }, env);
}

async function run() {
  guardOrExit('social-post');
  const env = loadEnv();
  const dryRun = String(env.SOCIAL_DRY_RUN || 'true').toLowerCase() !== 'false';

  const plan = loadPlan();
  if (!plan.length) { console.log('No content plan to post.'); return; }
  const today = todayStr();
  const due = plan.filter((p) => (p.status === 'rendered' || p.status === 'pending') && (p.date || today) <= today);
  if (!due.length) { console.log('Nothing rendered + due to post. ✅'); return; }

  if (!meta.metaConfigured(env) && !dryRun) { console.log('Social not connected (no META_PAGE_ID/META_PAGE_TOKEN). Staying safe — nothing posted.'); return; }

  const results = [];
  for (const item of due) {
    if (dryRun) {
      console.log(`[DRY RUN] Would post ${item.format} to ${item.platform || 'facebook'}: "${(item.caption || '').slice(0, 50)}..."`);
      results.push(`(preview) ${item.format}`);
      continue;
    }
    const r = await postItem(item, env);
    if (r.ok) { item.status = 'posted'; item.postedId = r.data && r.data.id; results.push(`✅ ${item.format}`); }
    else if (r.manual) { console.log(`Skipped ${item.id}: ${r.why}`); results.push(`✋ ${item.format} (manual)`); }
    else { item.status = 'post-error'; item.error = r.why || r.message; results.push(`⚠️ ${item.format}: ${item.error}`); }
    // Persist after EACH item (not just at the end) so a crash mid-run can never re-post something
    // that already went public on the next scheduled run.
    savePlan(plan);
  }
  const header = dryRun
    ? `🧪 Social preview (DRY-RUN — nothing posted). ${due.length} item(s) ready.`
    : `📣 Auto-post ran: ${results.join(', ')}`;
  await sendTelegram(header);
  console.log(header);
  if (dryRun) console.log('To go live: set SOCIAL_DRY_RUN=false in .env (after reviewing previews).');
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => console.log(`Social post error (will retry next run): ${err.message}`));
}
