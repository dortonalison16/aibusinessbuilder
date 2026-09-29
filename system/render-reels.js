// Creative reel renderer. Turns a reel timeline into an MP4:
//   background (gradient | image | video clip)  +  timed text/image overlays (motion, pop, fade,
//   slide, transitions)  +  captions.
//
// Pipeline: render each frame's overlays as a TRANSPARENT PNG (puppeteer), then ffmpeg composites
// the frame sequence over the background. ffmpeg + puppeteer both install automatically via npm.
//
// Backward compatible: an item with just `textStack` is auto-converted to an accumulating timeline.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ROOT } = require('./lib/config');
const { brandFromConfig: brandFrom } = require('./lib/brand');
const { renderHtmlToPng, loadPuppeteer } = require('./lib/render-image');
const rf = require('./lib/reel-frame');
const tpl = require('./lib/templates');

const CONTENT_DIR = path.join(ROOT, 'Content');
const PLAN = path.join(CONTENT_DIR, 'content-plan.json');
const OUT_DIR = path.join(CONTENT_DIR, 'rendered');

function resolveModule(names) { for (const n of names) { try { return require(n); } catch (_) {} } return null; }
function loadFfmpeg() {
  const fluent = resolveModule(['fluent-ffmpeg']);
  const installer = resolveModule(['@ffmpeg-installer/ffmpeg']);
  if (!fluent) throw new Error('fluent-ffmpeg not found — run "npm install" in the system folder.');
  if (installer && installer.path) { healMacFfmpeg(installer.path); fluent.setFfmpegPath(installer.path); }
  return fluent;
}

// On an Apple Silicon Mac the downloaded ffmpeg can arrive without a valid signature, and macOS
// kills it (SIGKILL) the moment it starts — every reel then fails. The fix is a local ad-hoc
// signature, which needs no password, so try it once here before giving up. If it doesn't help,
// the health check still names the problem and the command. Never throws.
function healMacFfmpeg(bin, { platform = process.platform, arch = process.arch, cp = require('child_process'), log = console.log } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64' || !bin) return 'skipped';
  try {
    const probe = () => cp.spawnSync(bin, ['-version'], { timeout: 15000, stdio: ['ignore', 'ignore', 'ignore'] });
    if (probe().signal !== 'SIGKILL') return 'ok';
    try { cp.execFileSync('codesign', ['--force', '--sign', '-', bin], { stdio: 'ignore', timeout: 30000 }); } catch (_) { /* reported below */ }
    const healed = probe().signal !== 'SIGKILL';
    log(healed
      ? 'The video engine was blocked by macOS — signed it on this Mac, and it runs now.'
      : 'The video engine is blocked by macOS and could not be fixed automatically — ask your assistant to run the health check.');
    return healed ? 'healed' : 'still-blocked';
  } catch (_) { return 'error'; }
}

function brandFromConfig() { return brandFrom(rf.DEFAULT_BRAND); }

// Relative media paths (overlays + backgrounds) are relative to the business folder.
const resolveSrc = (s) => (s && !/^(data:|https?:)/i.test(s) && !path.isAbsolute(s)) ? path.join(ROOT, s) : s;

// Shared merge-save (lib/plan): a save here can never un-post an item the poster published meanwhile.
const { loadPlan, savePlan, toPlanPath } = require('./lib/plan');

// Small eyebrow line, same rule as the feed images: the writer's kicker, else the angle names it.
function kickerOf(item, brand) {
  if (item.layout && item.layout.kicker === false) return '';
  if (item.kicker) return String(item.kicker);
  const angle = String(item.angle || '').toLowerCase();
  if (angle === 'value') return 'Quick tip';
  if (angle === 'story') return 'Real talk';
  return brand.name || '';
}
function hashOf(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

// Rough height (as a fraction of the frame) of a wrapped line at `size` px across `width` px.
function rowsOf(text, size, width) { return Math.max(1, Math.ceil(String(text).length / Math.max(1, Math.floor(width / (size * 0.53))))); }
function blockH(text, size, width) { return (rowsOf(text, size, width) * size * 1.12) / rf.H; }

// The text-stack layout: a big hook alone on frame 0 (the cover), which then shrinks and glides up
// to make room as each line arrives below it (varied entrances: fade-up, slide, pop). Earlier lines
// dim slightly so the newest one leads; the last line (3+ lines) becomes an accent pill — the CTA.
// Everything stays inside the safe zone (top 12% / bottom 20% are platform UI). Long lines are
// sized down so the whole stack always fits.
function stackTimeline(lines, duration, hold) {
  const X = 0.08, width = Math.round(0.84 * rf.W), TOP = rf.SAFE_TOP + 0.095, BOTTOM = rf.SAFE_BOTTOM - 0.03, GAP = 0.016;
  const hook = String(lines[0]);
  const rest = lines.slice(1).map(String);
  const entr = ['fade-up', 'slide-left', 'fade-up', 'pop', 'slide-left'];
  for (let scale = 1; scale >= 0.55; scale -= 0.05) {
    const hookBig = Math.round(tpl.fit(hook, 104, 32) * scale);
    const short = rest.length <= 2; // a 2-3 line stack can afford bigger type
    const hookSmall = Math.round(tpl.fit(hook, short ? 72 : 60, 40) * scale);
    const hookH = blockH(hook, hookSmall, width);
    let y = TOP + hookH + GAP * 2;
    const out = [];
    for (let i = 0; i < rest.length; i++) {
      const last = i === rest.length - 1 && rest.length >= 2;
      const size = Math.round((last ? tpl.fit(rest[i], 46, 30) : tpl.fit(rest[i], short ? 68 : 60, 40)) * scale);
      const h = last ? (size * 1.96) / rf.H : blockH(rest[i], size, width);
      const o = { type: 'text', text: rest[i], start: (i + 1) * hold, end: duration, out: 0, x: X, align: 'left', y: y + h / 2, size, anim: last ? 'pop' : entr[i % entr.length] };
      if (last) { o.style = 'pill'; o.y = y + h / 2 + 0.012; }
      else if (i + 1 < rest.length) o.stages = [{ at: (i + 2) * hold, opacity: 0.72 }];
      out.push(o);
      y += h + GAP;
    }
    if (y > BOTTOM && scale > 0.55) continue;
    // Center the finished stack in the content zone (a short stack pinned to the top left a void).
    const shift = Math.max(0, Math.min(0.46 - (TOP + (y - GAP)) / 2, BOTTOM - (y - GAP)));
    for (const o of out) o.y += shift;
    const hookO = { type: 'text', text: hook, start: 0, end: duration, out: 0, x: X, align: 'left', size: hookBig, y: 0.44, anim: 'fade' };
    if (rest.length) hookO.stages = [{ at: hold, y: TOP + shift + hookH / 2, size: hookSmall }, { at: 2 * hold, opacity: rest.length > 1 ? 0.9 : 1 }];
    return [hookO].concat(out);
  }
  return [];
}

// Build a timeline from the item. Supports rich `overlays`/`captions`, or a simple `textStack`.
function buildTimeline(item, brand = {}) {
  const fps = item.fps || 24;
  const hold = 1.5;
  let overlays = item.overlays;
  let captions = item.captions || [];
  let duration = item.durationSec;
  const background = item.background || { type: 'gradient' };

  if (!overlays && item.textStack) {
    const lines = item.textStack.map(String);
    duration = duration || lines.length * hold + 1.6;
    overlays = stackTimeline(lines, duration, hold);
  }
  overlays = (overlays || []).map((o) => (o.type === 'image' ? { ...o, src: resolveSrc(o.src) } : o));
  if (!duration) {
    const maxEnd = Math.max(0, ...overlays.map((o) => o.end || 0), ...captions.map((c) => c.end || 0));
    duration = maxEnd || 8;
  }
  const type = String(background.type || 'gradient').toLowerCase();
  // A photo/clip gets a numeric scrim strength once prepareBackground has looked at the picture
  // (lib/photo-scrim); until then it's the fixed 'strong' fallback.
  const chrome = { scrim: type === 'gradient' ? 'soft' : 'strong', kicker: kickerOf(item, brand), progress: !(item.layout && item.layout.progress === false) };
  return { fps, duration, overlays, captions, background, chrome };
}

// One frame of a clip (about a second in) as a PNG, so the clip can be measured like a photo.
function clipFrame(src, out, ffmpeg) {
  return new Promise((resolve) => {
    try { ffmpeg(src).seekInput(1).frames(1).on('end', () => resolve(out)).on('error', () => resolve(null)).save(out); }
    catch (_) { resolve(null); }
  });
}

async function prepareBackground(bg, brand, tmp, browser, seed = 0, ffmpeg = null) {
  const type = (bg.type || 'gradient').toLowerCase();
  const { scrimFor } = require('./lib/photo-scrim');
  // Relative clip/image paths resolve against the workspace ROOT (resolveSrc) so ffmpeg (which runs
  // with the system folder as cwd) can find them regardless of where the script is launched from.
  if (type === 'image') { const src = resolveSrc(bg.src); return { kind: 'image', src, scrim: await scrimFor(src, browser, { width: rf.W, height: rf.H }) }; }
  if (type === 'clip' || type === 'video') {
    const src = resolveSrc(bg.src);
    const frame = ffmpeg && fs.existsSync(src) ? await clipFrame(src, path.join(tmp, 'clip-frame.png'), ffmpeg) : null;
    return { kind: 'video', src, scrim: frame ? await scrimFor(frame, browser, { width: rf.W, height: rf.H }) : undefined };
  }
  // gradient -> render a still bg image (on the shared browser: launching a second Chrome per reel
  // was the slowest part of a render).
  const out = path.join(tmp, 'bg.png');
  await renderHtmlToPng({ html: rf.gradientBgHtml({ colors: bg.colors, brand, seed }), width: rf.W, height: rf.H, outPath: out, scale: 1 }, browser);
  return { kind: 'image', src: out };
}

// Background + frames + progress bar -> mp4. The background gets a slow Ken Burns push-in with a
// gentle sideways drift (zoompan), so even a plain gradient is never a static wall. The progress
// fill is a white bar slid in from the left by ffmpeg — drawing it in the frames would make every
// frame unique and defeat the de-dup that keeps renders fast.
function compose(bg, framesPattern, fps, duration, out, ffmpeg, progress = true) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    if (bg.kind === 'image') cmd.input(bg.src).inputOptions(['-loop 1']);
    else cmd.input(bg.src).inputOptions(['-stream_loop -1']);
    cmd.input(framesPattern).inputOptions(['-framerate ' + fps]);
    const N = Math.max(1, Math.round(duration * fps));
    const barW = Math.round(rf.W * 0.84), barX = Math.round(rf.W * 0.08), barY = Math.round(rf.H * rf.SAFE_BOTTOM);
    const filters = [
      `[0:v]scale=${rf.W}:${rf.H}:force_original_aspect_ratio=increase,crop=${rf.W}:${rf.H},setsar=1,fps=${fps},`
      + `zoompan=z='1.0+0.09*on/${N}':x='iw/2-(iw/zoom/2)+(iw*0.012)*sin(on/${N}*3.1416)':y='ih/2-(ih/zoom/2)':d=1:s=${rf.W}x${rf.H}:fps=${fps}[bg]`,
      '[bg][1:v]overlay=shortest=1[v1]',
    ];
    if (progress) {
      cmd.input(`color=c=white@0.9:s=${barW}x6:r=${fps}`).inputFormat('lavfi');
      filters.push(`[v1][2:v]overlay=x='${barX - barW}+${barW}*t/${duration}':y=${barY}:shortest=1,format=yuv420p[v]`);
    } else filters.push('[v1]format=yuv420p[v]');
    cmd.complexFilter(filters, 'v');
    cmd.outputOptions(['-r ' + fps, '-t ' + duration, '-movflags +faststart'])
      .on('end', resolve).on('error', reject).save(out);
  });
}

async function renderReel(item, brand, ffmpeg, browser) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const tl = buildTimeline(item, brand);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  // Cleaned up even when the reel fails — each failed reel used to leave hundreds of MB of frames.
  try { return await renderFrames(item, tl, brand, ffmpeg, browser, tmp); }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
}

async function renderFrames(item, tl, brand, ffmpeg, browser, tmp) {
  const framesDir = path.join(tmp, 'frames');
  fs.mkdirSync(framesDir);

  const bg = await prepareBackground(tl.background, brand, tmp, browser, hashOf(item.id), ffmpeg);
  if (Number.isFinite(bg.scrim)) tl.chrome.scrim = bg.scrim;

  // Most frames of a text reel are identical holds between animations. Only screenshot a frame when
  // it differs from the previous one; otherwise copy the previous PNG (several times faster).
  // One page is reused for every frame (a fresh page + a network-idle wait per frame used to cost
  // more than the screenshot itself; nothing here loads from the network — images are data: URIs).
  const totalFrames = Math.max(1, Math.round(tl.duration * tl.fps));
  const page = await browser.newPage();
  await page.setViewport({ width: rf.W, height: rf.H, deviceScaleFactor: 1 });
  let prevHtml = null, prevPath = null;
  try {
    for (let f = 0; f < totalFrames; f++) {
      const t = f / tl.fps;
      const html = rf.frameHtml({ overlays: tl.overlays, captions: tl.captions, t, brand, chrome: tl.chrome, duration: tl.duration });
      const fp = path.join(framesDir, `f${String(f).padStart(5, '0')}.png`);
      if (html === prevHtml) fs.copyFileSync(prevPath, fp);
      else {
        await page.setContent(html, { waitUntil: 'load' });
        await page.screenshot({ path: fp, clip: { x: 0, y: 0, width: rf.W, height: rf.H }, omitBackground: true });
      }
      prevHtml = html; prevPath = fp;
    }
  } finally { await page.close(); }

  const out = path.join(OUT_DIR, `${item.id}.mp4`);
  await compose(bg, path.join(framesDir, 'f%05d.png'), tl.fps, tl.duration, out, ffmpeg, tl.chrome.progress);
  return out;
}

async function run() {
  const plan = loadPlan();
  if (!plan.length) { console.log('No content plan found.'); return; }
  const reels = plan.filter((i) => ['silent_reel', 'reel'].includes((i.format || '').toLowerCase()) && (!i.status || i.status === 'planned' || i.status === 'pending'));
  if (!reels.length) { console.log('No reels to render. ✅'); return; }
  try { require('./lib/prune-rendered').pruneRendered(); } catch (_) { /* tidying must never block a render */ }

  const ffmpeg = loadFfmpeg();
  const brand = brandFromConfig();
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let done = 0, failed = 0;
  try {
    for (const item of reels) {
      try {
        const out = await renderReel(item, brand, ffmpeg, browser);
        item.mediaPaths = [toPlanPath(out)]; // relative to the business folder (lib/plan)
        item.status = 'rendered';
        delete item.error;
        done++;
        console.log(`Rendered reel "${(item.caption || item.id).toString().slice(0, 40)}" -> ${path.basename(out)}`);
      } catch (e) {
        // One bad reel must never cost the rest of the week.
        failed++;
        item.error = `render failed: ${e.message}`;
        console.log(`Could not render reel ${item.id}: ${e.message}`);
      }
      savePlan(plan);
    }
  } finally { await browser.close(); }
  console.log(`Done — rendered ${done} reel(s)${failed ? `, ${failed} failed (see "error" in the plan — they'll be tried again next run). ⚠️` : '. ✅'}`);
  // Any failure counts, even when others rendered: the weekly job then reports the step and leaves
  // the week unmarked, so its catch-up run renders just the reels still waiting (status "planned").
  if (failed) process.exitCode = 1;
  return { rendered: done, failed };
}

module.exports = { run, renderReel, buildTimeline, healMacFfmpeg };

if (require.main === module) {
  run().catch((e) => { console.log(`Reel render error: ${e.message}`); process.exitCode = 1; });
}
