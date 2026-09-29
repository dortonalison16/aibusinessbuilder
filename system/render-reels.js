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
const { ROOT, getConfigValue } = require('./lib/config');
const { renderHtmlToPng, loadPuppeteer } = require('./lib/render-image');
const rf = require('./lib/reel-frame');

const CONTENT_DIR = path.join(ROOT, 'Content');
const PLAN = path.join(CONTENT_DIR, 'content-plan.json');
const OUT_DIR = path.join(CONTENT_DIR, 'rendered');

function resolveModule(names) { for (const n of names) { try { return require(n); } catch (_) {} } return null; }
function loadFfmpeg() {
  const fluent = resolveModule(['fluent-ffmpeg']);
  const installer = resolveModule(['@ffmpeg-installer/ffmpeg']);
  if (!fluent) throw new Error('fluent-ffmpeg not found — run "npm install" in the system folder.');
  if (installer && installer.path) fluent.setFfmpegPath(installer.path);
  return fluent;
}

function brandFromConfig() {
  const palette = getConfigValue('Brand & Look', '') || '';
  const hexes = palette.match(/#[0-9a-fA-F]{6}/g) || [];
  const b = { ...rf.DEFAULT_BRAND };
  if (hexes[0]) b.primary = hexes[0];
  if (hexes[1]) b.accent = hexes[1];
  return b;
}

function loadPlan() { try { return JSON.parse(fs.readFileSync(PLAN, 'utf8')); } catch (_) { return []; } }
function savePlan(p) { fs.writeFileSync(PLAN, JSON.stringify(p, null, 2)); }

// Build a timeline from the item. Supports rich `overlays`/`captions`, or a simple `textStack`.
function buildTimeline(item) {
  const fps = item.fps || 24;
  const hold = 1.4;
  let overlays = item.overlays;
  let captions = item.captions || [];
  let duration = item.durationSec;
  const background = item.background || { type: 'gradient' };

  if (!overlays && item.textStack) {
    // Accumulating text-stack style: each line fades up and stays.
    const lines = item.textStack;
    duration = duration || lines.length * hold + 1;
    overlays = lines.map((text, i) => ({ type: 'text', text, start: i * hold, end: duration, y: 0.26 + i * 0.1, size: 70, anim: 'fade-up' }));
  }
  overlays = overlays || [];
  if (!duration) {
    const maxEnd = Math.max(0, ...overlays.map((o) => o.end || 0), ...captions.map((c) => c.end || 0));
    duration = maxEnd || 8;
  }
  return { fps, duration, overlays, captions, background };
}

async function prepareBackground(bg, brand, tmp) {
  const type = (bg.type || 'gradient').toLowerCase();
  // Resolve relative clip/image paths against the workspace ROOT so ffmpeg (which runs with the
  // system folder as cwd) can find them regardless of where the script is launched from.
  const resolveSrc = (s) => (s && !path.isAbsolute(s)) ? path.join(ROOT, s) : s;
  if (type === 'image') return { kind: 'image', src: resolveSrc(bg.src) };
  if (type === 'clip' || type === 'video') return { kind: 'video', src: resolveSrc(bg.src) };
  // gradient -> render a still bg image
  const out = path.join(tmp, 'bg.png');
  await renderHtmlToPng({ html: rf.gradientBgHtml({ colors: bg.colors, brand }), width: rf.W, height: rf.H, outPath: out, scale: 1 });
  return { kind: 'image', src: out };
}

function compose(bg, framesPattern, fps, duration, out, ffmpeg) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    if (bg.kind === 'image') cmd.input(bg.src).inputOptions(['-loop 1']);
    else cmd.input(bg.src).inputOptions(['-stream_loop -1']);
    cmd.input(framesPattern).inputOptions(['-framerate ' + fps]);
    cmd.complexFilter([
      `[0:v]scale=${rf.W}:${rf.H}:force_original_aspect_ratio=increase,crop=${rf.W}:${rf.H},setsar=1,fps=${fps}[bg]`,
      `[bg][1:v]overlay=shortest=1,format=yuv420p[v]`,
    ], 'v');
    cmd.outputOptions(['-r ' + fps, '-t ' + duration, '-movflags +faststart'])
      .on('end', resolve).on('error', reject).save(out);
  });
}

async function renderReel(item, brand, ffmpeg, browser) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const tl = buildTimeline(item);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  const framesDir = path.join(tmp, 'frames');
  fs.mkdirSync(framesDir);

  const bg = await prepareBackground(tl.background, brand, tmp);

  const totalFrames = Math.max(1, Math.round(tl.duration * tl.fps));
  for (let f = 0; f < totalFrames; f++) {
    const t = f / tl.fps;
    const html = rf.frameHtml({ overlays: tl.overlays, captions: tl.captions, t, brand });
    const fp = path.join(framesDir, `f${String(f).padStart(5, '0')}.png`);
    await renderHtmlToPng({ html, width: rf.W, height: rf.H, outPath: fp, scale: 1, transparent: true }, browser);
  }

  const out = path.join(OUT_DIR, `${item.id}.mp4`);
  await compose(bg, path.join(framesDir, 'f%05d.png'), tl.fps, tl.duration, out, ffmpeg);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  return out;
}

async function run() {
  const plan = loadPlan();
  if (!plan.length) { console.log('No content plan found.'); return; }
  const reels = plan.filter((i) => ['silent_reel', 'reel'].includes((i.format || '').toLowerCase()) && (!i.status || i.status === 'planned' || i.status === 'pending'));
  if (!reels.length) { console.log('No reels to render. ✅'); return; }

  const ffmpeg = loadFfmpeg();
  const brand = brandFromConfig();
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  let done = 0;
  try {
    for (const item of reels) {
      const out = await renderReel(item, brand, ffmpeg, browser);
      item.mediaPaths = [out];
      item.status = 'rendered';
      done++;
      console.log(`Rendered reel "${(item.caption || item.id).toString().slice(0, 40)}" -> ${path.basename(out)}`);
    }
  } finally { await browser.close(); }
  savePlan(plan);
  console.log(`Done — rendered ${done} reel(s). ✅`);
}

module.exports = { run, renderReel, buildTimeline };

if (require.main === module) {
  run().catch((e) => { console.log(`Reel render error: ${e.message}`); process.exitCode = 1; });
}
