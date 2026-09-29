// Builds the HTML for ONE frame of a reel at time t. All creative effects live here:
// timed text + image overlays, motion (fade / slide / pop), staged moves (a hook that shrinks and
// slides up as more lines arrive), popups, captions, and entry/exit transitions. The renderer
// screenshots this with a TRANSPARENT background, then ffmpeg composites the frame sequence over
// the background (gradient / image / video clip) with a slow Ken Burns drift and a progress bar.
//
// Safe zones: text stays out of the top ~12% and bottom ~20% of the frame, where the platform's
// own UI (username, caption, buttons) sits.

const tpl = require('./templates');

const W = 1080, H = 1920;
const SAFE_TOP = 0.12, SAFE_BOTTOM = 0.80;

// NOTE: font stack uses SINGLE quotes — these values go into inline style="" attributes, so a
// double-quoted font name would prematurely close the attribute and break every later style.
const DEFAULT_BRAND = { primary: '#5b54e6', accent: '#19c3b2', text: '#1f2430', font: "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Roboto, Arial, sans-serif" };

const esc = tpl.esc;
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function easeOutBack(p) { const s = 1.70158; const x = p - 1; return 1 + (s + 1) * x * x * x + s * x * x; }
function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }
function easeInOut(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }
const lerp = (a, b, p) => a + (b - a) * p;

// Compute opacity + transform for an overlay at time t.
function animState(o, t, duration) {
  const inDur = o.in != null ? o.in : 0.45;
  const start = o.start || 0;
  const end = o.end != null ? o.end : start + 3;
  // Anything that lasts to the end of the reel holds instead of fading out: the last frame is what
  // a viewer sees on the loop point (and in some grid previews) and should not be an empty background.
  const outDur = o.out != null ? o.out : (duration && end >= duration - 0.05 ? 0 : 0.35);
  if (t < start || t > end) return null; // not visible
  // Anything on screen from t=0 is the HOOK: fully visible on frame 0, no fade-in. The first frame
  // is the cover/grid thumbnail and what a scroller sees before deciding — a fading-in hook means
  // that frame is an empty background.
  const pin = start <= 0 ? 1 : clamp((t - start) / Math.max(inDur, 0.001), 0, 1);
  const pout = outDur > 0 ? clamp((end - t) / outDur, 0, 1) : 1;
  const opacity = Math.min(easeOutCubic(pin), pout);
  let tf = '';
  switch ((o.anim || 'fade')) {
    case 'fade-up': tf = `translateY(${(1 - easeOutCubic(pin)) * 50}px)`; break;
    case 'fade-down': tf = `translateY(${-(1 - easeOutCubic(pin)) * 50}px)`; break;
    case 'slide-left': tf = `translateX(${(1 - easeOutCubic(pin)) * 160}px)`; break;
    case 'slide-right': tf = `translateX(${-(1 - easeOutCubic(pin)) * 160}px)`; break;
    case 'pop': tf = `scale(${0.6 + 0.4 * easeOutBack(pin)})`; break;
    case 'fade': default: tf = ''; break;
  }
  return { opacity, tf };
}

// Staged properties: `stages: [{ at, y, size, opacity }]` — the overlay glides from one stage to
// the next over `moveDur` seconds (the hook shrinking and moving up as lines accumulate).
function stagedProps(o, t) {
  const base = { y: o.y == null ? 0.5 : o.y, size: o.size || 72, opacity: 1 };
  if (!Array.isArray(o.stages) || !o.stages.length) return base;
  const moveDur = o.moveDur || 0.5;
  let cur = base, prev = base, since = Infinity;
  for (const st of o.stages) {
    if (t < (st.at || 0)) break;
    prev = cur; cur = { ...cur, ...st }; since = t - (st.at || 0);
  }
  const p = since === Infinity ? 1 : easeInOut(clamp(since / moveDur, 0, 1));
  return { y: lerp(prev.y, cur.y, p), size: lerp(prev.size, cur.size, p), opacity: lerp(prev.opacity, cur.opacity, p) };
}

function posPx(o, y) {
  const x = o.x === 'center' || o.x == null ? 0.5 : o.x;
  return { left: Math.round(x * W), top: Math.round((y == null ? (o.y == null ? 0.5 : o.y) : y) * H) };
}

function textOverlay(o, t, brand, duration) {
  const st = animState(o, t, duration); if (!st) return '';
  const sp = stagedProps(o, t);
  const { left, top } = posPx(o, sp.y);
  const size = Math.round(sp.size);
  const color = o.color || '#ffffff';
  const weight = o.weight || 800;
  const maxW = Math.round((o.maxWidth || 0.84) * W);
  const align = o.align || 'center';
  const anchor = align === 'left' ? 'translate(0,-50%)' : 'translate(-50%,-50%)';
  const opacity = (st.opacity * sp.opacity).toFixed(3);
  const font = o.font || brand.headFont || brand.font;
  if (o.style === 'pill') {
    // A call-to-action line: brand-accent pill, dark text.
    return `<div style="position:absolute;left:${left}px;top:${top}px;transform:${anchor} ${st.tf};opacity:${opacity};
      max-width:${maxW}px;text-align:${align};font-family:${brand.font};">
      <span style="display:inline-block;background:${brand.accent};color:${tpl.darken(brand.primary, 0.35)};font-weight:800;font-size:${size}px;line-height:1.2;
      padding:${Math.round(size * 0.38)}px ${Math.round(size * 0.7)}px;border-radius:999px;box-shadow:0 12px 40px rgba(0,0,0,.35);">${esc(o.text)}</span></div>`;
  }
  return `<div style="position:absolute;left:${left}px;top:${top}px;
    transform:${anchor} ${st.tf};opacity:${opacity};
    width:${maxW}px;text-align:${align};font-family:${font};font-weight:${weight};letter-spacing:-.01em;
    font-size:${size}px;line-height:1.12;color:${color};text-wrap:balance;
    text-shadow:0 4px 28px rgba(0,0,0,.45);">${esc(o.text)}</div>`;
}

const toDataUri = tpl.toDataUri;

function imageOverlay(o, t, duration) {
  const st = animState(o, t, duration); if (!st) return '';
  const { left, top } = posPx(o);
  const w = Math.round((o.w || 0.3) * W);
  const src = toDataUri(o.src);
  if (!src) return '';
  return `<img src="${src}" style="position:absolute;left:${left}px;top:${top}px;
    transform:translate(-50%,-50%) ${st.tf};opacity:${st.opacity.toFixed(3)};
    width:${w}px;height:auto;border-radius:${o.radius || 0}px;
    filter:drop-shadow(0 8px 30px rgba(0,0,0,.35));"/>`;
}

// Caption band — sits just above the bottom safe zone.
function caption(c, t, brand, duration) {
  const st = animState({ ...c, anim: 'fade-up', in: 0.25 }, t, duration); if (!st) return '';
  return `<div style="position:absolute;left:50%;top:${Math.round(H * 0.74)}px;transform:translate(-50%,-50%) ${st.tf};
    opacity:${st.opacity.toFixed(3)};max-width:${Math.round(0.86 * W)}px;text-align:center;
    font-family:${brand.font};font-weight:800;font-size:50px;line-height:1.2;color:#fff;
    background:rgba(0,0,0,.42);padding:16px 34px;border-radius:20px;border:1px solid rgba(255,255,255,.14);
    text-shadow:0 3px 18px rgba(0,0,0,.5);">${esc(c.text)}</div>`;
}

// Persistent chrome: a dark scrim, the kicker line up top and the progress-bar track. The moving
// progress fill is drawn by ffmpeg so frames can still be de-duped.
// `scrim`: 'soft' (the brand gradient — unchanged), 'none', or a NUMBER 0..1 for a photo/clip
// background (lib/photo-scrim: how bright the picture is behind the copy). The photo scrim is
// bottom-weighted — light across the top so the picture reads, darkest under the copy zone and the
// footer. 'strong' (the old flat photo scrim) now means a fixed 0.75.
function chromeHtml(chrome, b) {
  const parts = [];
  const scrim = chrome.scrim == null ? 'soft' : chrome.scrim;
  if (scrim === 'soft') {
    parts.push('<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0.22) 0%,rgba(0,0,0,0.06) 40%,rgba(0,0,0,0.40) 100%);"></div>');
  } else if (scrim !== 'none') {
    const k = Math.max(0, Math.min(1, Number.isFinite(Number(scrim)) ? Number(scrim) : 0.75));
    const a = (lo, hi) => (lo + (hi - lo) * k).toFixed(2);
    parts.push(`<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,${a(0.06, 0.34)}) 0%,rgba(0,0,0,${a(0.14, 0.62)}) 20%,rgba(0,0,0,${a(0.24, 0.84)}) 40%,rgba(0,0,0,${a(0.30, 0.86)}) 78%,rgba(0,0,0,${a(0.40, 0.92)}) 100%);"></div>`);
    parts.push(`<div style="position:absolute;inset:0;background:${tpl.rgba(b.primary, a(0.06, 0.22))};mix-blend-mode:multiply;"></div>`);
  }
  if (chrome.kicker) {
    parts.push(`<div style="position:absolute;left:${Math.round(W * 0.08)}px;top:${Math.round(H * 0.155)}px;font-family:${b.font};">${tpl.kickerHtml(chrome.kicker, b, { size: 28 })}</div>`);
  }
  if (chrome.progress !== false) {
    parts.push(`<div style="position:absolute;left:${Math.round(W * 0.08)}px;top:${Math.round(H * SAFE_BOTTOM)}px;width:${Math.round(W * 0.84)}px;height:6px;border-radius:3px;background:rgba(255,255,255,.22);"></div>`);
  }
  if (chrome.footer) {
    parts.push(`<div style="position:absolute;left:${Math.round(W * 0.08)}px;right:${Math.round(W * 0.08)}px;top:${Math.round(H * SAFE_BOTTOM) + 26}px;display:flex;justify-content:space-between;font-family:${b.font};font-size:24px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;color:rgba(255,255,255,.7);"><span>${esc(chrome.footer)}</span>${chrome.handle ? `<span style="text-transform:none;letter-spacing:.04em;">${esc(chrome.handle)}</span>` : ''}</div>`);
  }
  return parts.join('');
}

// Full transparent frame at time t. `chrome` = { scrim: 'soft'|'none'|0..1, kicker, footer,
// handle, progress } — all optional.
function frameHtml({ overlays = [], captions = [], t = 0, brand, chrome = {}, duration }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const parts = [chromeHtml(chrome, b)];
  for (const o of overlays) parts.push(o.type === 'image' ? imageOverlay(o, t, duration) : textOverlay(o, t, b, duration));
  for (const c of captions) parts.push(caption(c, t, b, duration));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;}
    html,body{width:${W}px;height:${H}px;background:transparent;overflow:hidden;-webkit-font-smoothing:antialiased;}
  </style></head><body><div style="position:relative;width:${W}px;height:${H}px;">${parts.join('')}</div></body></html>`;
}

// A standalone background image (used when background.type === 'gradient'): the same layered
// brand backdrop the feed images use, rendered slightly larger so the Ken Burns drift has room.
function gradientBgHtml({ colors, brand, seed = 0 }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  if (colors && colors[0]) b.primary = colors[0];
  if (colors && colors[1]) b.accent = colors[1];
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;}</style></head>
    <body style="width:${W}px;height:${H}px;overflow:hidden;"><div style="position:relative;width:${W}px;height:${H}px;overflow:hidden;">${tpl.darkLayers(b, { w: W, h: H, seed })}</div></body></html>`;
}

module.exports = { frameHtml, gradientBgHtml, W, H, DEFAULT_BRAND, SAFE_TOP, SAFE_BOTTOM };
