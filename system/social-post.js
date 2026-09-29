// Auto-posts the rendered content plan to Facebook/Instagram.
//
// SAFETY: ships in DRY-RUN by default — only logs what it WOULD post until the buyer sets
// SOCIAL_DRY_RUN=false in .env. Works off Content/content-plan.json (the same file the writer
// and renderers use): posts items that are RENDERED and DUE (their date is today or earlier),
// then marks them posted.
//
// Never posted from here:
//   - meta_ad items (ads belong in Ads Manager, not the organic feed)
//   - talking_reel items (a script to film, not a finished video)
//   - items with no date (so a plan without dates can't dump a whole week in one run)
// Things that need a human (e.g. an Instagram reel without a public video URL) are flagged ONCE
// as "manual" and then left alone, instead of re-pinging every day.
//
// Instagram needs a public image URL, so local rendered images are hosted first (IMGBB_API_KEY).
// Facebook uploads local files directly.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./lib/config');
const { guardOrExit } = require('./lib/working-hours');
const { sendTelegram, loadEnv } = require('./lib/telegram');
const meta = require('./lib/meta');
const { hostImage } = require('./lib/host-image');

// Shared merge-save (lib/plan): the renderers and this poster can overlap, and a "posted" mark must
// survive whichever job saves last.
const { loadPlan, savePlan, resolveMedia } = require('./lib/plan');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function todayStr() { return ymd(new Date()); }

// A plan's dates are compared as text ("2026-10-05" <= "2026-10-12"), so every date is first put in
// that one shape. A hand-written "2026-10-5" sorted AFTER "2026-10-12" and never came due, and an
// ISO timestamp ("2026-10-05T09:00:00Z") only matched by luck. Returns local YYYY-MM-DD, or null
// when it isn't a date at all.
function normDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getMonth() === Number(m[2]) - 1 ? ymd(d) : null; // "2026-02-31" is not a date
  }
  if (!/^\d{4}-\d{1,2}-\d{1,2}T/.test(s)) return null; // only full ISO timestamps beyond plain dates
  const t = new Date(s);
  return Number.isFinite(t.getTime()) ? ymd(t) : null; // the owner's calendar day for that moment
}

const NOT_FOR_FEED = ['meta_ad', 'talking_reel'];
// A video ad for the Meta Ads Agent is rendered as a plain "reel" left WITHOUT a date on purpose (so
// it never reaches the feed). Those, and anything marked as an ad, aren't waiting for a date — so
// the "give them a date" reminder skips them. (They are never posted either way: no date = not due.)
function isAdItem(p) {
  if (String(p.format || '').toLowerCase() === 'meta_ad') return true;
  if (p.ad === true || p.forAds === true || /^(ad|ads|meta_ad|meta-ad)$/i.test(String(p.purpose || p.use || p.angle || ''))) return true;
  return /(^|[-_])(ad|ads|metaad)([-_]?\d*)?($|[-_])/i.test(String(p.id || ''));
}
const MAX_ATTEMPTS = 3;
// An item this many days past its date is no longer "due" — it's a backlog. Going live after a week
// of previews (or a laptop that was shut for a while) must not dump every old post on the page in
// one minute; those are skipped with a note, and the owner can re-date any they still want.
const STALE_DAYS = 3;

// Host every local image and return public URLs (needed for Instagram). Returns null on any failure.
async function hostAll(paths, env) {
  const urls = [];
  for (const p of paths) { const h = await hostImage(p, env); if (!h.ok) return null; urls.push(h.url); }
  return urls;
}

async function postItem(item, env) {
  const platform = (item.platform || 'facebook').toLowerCase();
  const fmt = (item.format || 'post').toLowerCase();
  // Relative paths (and old full paths from before the folder moved) are found via lib/plan.
  const media = (item.mediaPaths || []).map((p) => resolveMedia(p)).filter(Boolean);

  // ── Carousel (multi-image) ──
  if (fmt === 'carousel') {
    if (!media.length) return { ok: false, why: 'no rendered slides' };
    if (platform === 'instagram') {
      const urls = await hostAll(media.slice(0, 10), env);
      if (!urls) return { ok: false, why: 'could not host carousel images for Instagram (check IMGBB_API_KEY)' };
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
      return { ok: false, manual: true, why: 'Instagram reels need a public video link — the video is ready in Content/rendered to post from your phone' };
    }
    return meta.postFacebookVideo({ videoPath: media[0], caption: item.caption }, env); // FB uploads the local MP4
  }

  // ── Story ──
  if (fmt === 'story') {
    if (!media[0]) return { ok: false, why: 'no rendered story image' };
    if (platform !== 'instagram') return { ok: false, manual: true, why: 'Facebook stories can\'t be posted automatically — the image is ready in Content/rendered' };
    const h = await hostImage(media[0], env);
    if (!h.ok) return { ok: false, why: `couldn't host the story image for Instagram (${h.reason})` };
    return meta.postInstagramStory({ imageUrl: h.url }, env);
  }

  // ── Single image post ──
  if (platform === 'instagram') {
    if (!media[0]) return { ok: false, why: 'no rendered image' };
    const h = await hostImage(media[0], env);
    if (!h.ok) return { ok: false, why: `couldn't host the image for Instagram (${h.reason})` };
    return meta.postInstagramPhoto({ imageUrl: h.url, caption: item.caption }, env);
  }
  if (media[0]) return meta.postFacebookLocalPhoto({ imagePath: media[0], caption: item.caption }, env);
  return meta.postFacebookText({ message: item.caption }, env);
}

async function run() {
  guardOrExit('social-post');
  const env = loadEnv();
  const dryRun = String(env.SOCIAL_DRY_RUN || 'true').toLowerCase() !== 'false';

  const plan = loadPlan();
  if (!plan.length) { console.log('No content plan to post.'); return; }
  const today = todayStr();
  const isFeed = (p) => !NOT_FOR_FEED.includes(String(p.format || '').toLowerCase());
  // Only RENDERED items ("pending" means not rendered yet — posting it sent a caption with no image).
  // A failed post is retried on the next runs (Instagram "still processing", a network blip), up to
  // MAX_ATTEMPTS, then left as post-error for the owner.
  const retry = (p) => p.status === 'post-error' && (p.attempts || 1) < MAX_ATTEMPTS;
  const dayOf = (p) => normDate(p.date);
  const due = plan.filter((p) => isFeed(p) && (p.status === 'rendered' || retry(p)) && dayOf(p) && dayOf(p) <= today);
  const undated = plan.filter((p) => isFeed(p) && !isAdItem(p) && p.status === 'rendered' && !dayOf(p)).length;
  if (undated) console.log(`(${undated} item(s) have no posting date (or one I can't read), so they're waiting — give them a date to schedule them.)`);
  if (!due.length) { console.log('Nothing rendered + due to post today. ✅'); return; }

  if (!meta.metaConfigured(env) && !dryRun) { console.log('Social not connected (no META_PAGE_ID/META_PAGE_TOKEN). Staying safe — nothing posted.'); return; }

  const results = [];
  const manual = [];
  const skipped = [];
  const staleBefore = ymd(new Date(Date.now() - STALE_DAYS * 864e5));
  for (const item of due) {
    if (dryRun) {
      console.log(`[DRY RUN] Would post ${item.format} to ${item.platform || 'facebook'}: "${(item.caption || '').slice(0, 50)}..."${dayOf(item) < staleBefore ? ' (past its date — would be skipped live)' : ''}`);
      results.push(`(preview) ${item.format}`);
      continue;
    }
    if (dayOf(item) < staleBefore) {
      item.status = 'skipped';
      item.note = `was due ${dayOf(item)} — more than ${STALE_DAYS} days ago, so it wasn't posted late. Give it a new date to post it.`;
      skipped.push(`${item.format} (${dayOf(item)})`);
      savePlan(plan);
      continue;
    }
    const wasError = item.status === 'post-error';
    const r = await postItem(item, env).catch((e) => ({ ok: false, why: e.message }));
    if (r.ok) { item.status = 'posted'; item.postedAt = new Date().toISOString(); item.postedId = r.data && r.data.id; delete item.error; results.push(`✅ ${item.format}`); }
    else if (r.manual) { item.status = 'manual'; item.note = r.why; manual.push(`✋ ${item.format}: ${r.why}`); }
    else {
      item.status = 'post-error'; item.error = r.why || r.error || r.message;
      item.attempts = wasError ? (item.attempts || 1) + 1 : 1;
      results.push(`⚠️ ${item.format}: ${item.error}${item.attempts >= MAX_ATTEMPTS ? ' (gave up — ask your assistant to look at it)' : ' (will retry next run)'}`);
    }
    // Persist after EACH item (not just at the end) so a crash mid-run can never re-post something
    // that already went public on the next scheduled run.
    savePlan(plan);
  }
  const header = dryRun
    ? `🧪 Social preview (DRY-RUN — nothing posted). ${due.length} item(s) due today.`
    : `📣 Auto-post ran: ${results.join(', ') || 'nothing automatic today'}`;
  let msg = manual.length ? `${header}\n\nReady for you to post by hand:\n${manual.join('\n')}` : header;
  if (skipped.length) msg += `\n\n⏭️ ${skipped.length} older item(s) were past their date and were NOT posted late: ${skipped.join(', ')}. Ask your assistant to re-date any you still want.`;
  await sendTelegram(msg, env);
  console.log(msg);
  if (dryRun) console.log('To go live: set SOCIAL_DRY_RUN=false in .env (after reviewing previews).');
}

module.exports = { run, normDate, isAdItem };

if (require.main === module) {
  run().catch((err) => { console.log(`Social post error (will retry next run): ${err.message}`); process.exitCode = 1; });
}
