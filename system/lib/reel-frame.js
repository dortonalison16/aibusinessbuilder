// Builds the HTML for ONE frame of a reel at time t. All creative effects live here:
// timed text + image overlays, motion (fade / slide / pop), popups, captions, and entry/exit
// transitions. The renderer screenshots this with a TRANSPARENT background, then ffmpeg
// composites the frame sequence over the background (gradient / image / video clip).

const W = 1080, H = 1920;

// NOTE: font stack uses SINGLE quotes — these values go into inline style="" attributes, so a
// double-quoted font name would prematurely close the attribute and break every later style.
const DEFAULT_BRAND = { primary: '#5b54e6', accent: '#19c3b2', text: '#1f2430', font: "'Segoe UI', system-ui, Arial, sans-serif" };

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function easeOutBack(p) { const s = 1.70158; const x = p - 1; return 1 + (s + 1) * x * x * x + s * x * x; }
function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }

// Compute opacity + transform for an overlay at time t.
function animState(o, t) {
  const inDur = o.in != null ? o.in : 0.4;
  const outDur = o.out != null ? o.out : 0.35;
  const start = o.start || 0;
  const end = o.end != null ? o.end : start + 3;
  if (t < start || t > end) return null; // not visible
  const pin = clamp((t - start) / Math.max(inDur, 0.001), 0, 1);
  const pout = clamp((end - t) / Math.max(outDur, 0.001), 0, 1);
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

function posPx(o) {
  const x = o.x === 'center' || o.x == null ? 0.5 : o.x;
  const y = o.y == null ? 0.5 : o.y;
  return { left: Math.round(x * W), top: Math.round(y * H) };
}

function textOverlay(o, t, brand) {
  const st = animState(o, t); if (!st) return '';
  const { left, top } = posPx(o);
  const size = o.size || 72;
  const color = o.color || '#ffffff';
  const weight = o.weight || 800;
  const maxW = Math.round((o.maxWidth || 0.84) * W);
  return `<div style="position:absolute;left:${left}px;top:${top}px;
    transform:translate(-50%,-50%) ${st.tf};opacity:${st.opacity.toFixed(3)};
    width:${maxW}px;text-align:center;font-family:${brand.font};font-weight:${weight};
    font-size:${size}px;line-height:1.15;color:${color};
    text-shadow:0 4px 28px rgba(0,0,0,.45);">${esc(o.text)}</div>`;
}

function imageOverlay(o, t) {
  const st = animState(o, t); if (!st) return '';
  const { left, top } = posPx(o);
  const w = Math.round((o.w || 0.3) * W);
  const src = 'file:///' + String(o.src || '').replace(/\\/g, '/');
  return `<img src="${src}" style="position:absolute;left:${left}px;top:${top}px;
    transform:translate(-50%,-50%) ${st.tf};opacity:${st.opacity.toFixed(3)};
    width:${w}px;height:auto;border-radius:${o.radius || 0}px;
    filter:drop-shadow(0 8px 30px rgba(0,0,0,.35));"/>`;
}

function caption(c, t, brand) {
  const st = animState({ ...c, anim: 'fade', in: 0.2, out: 0.2 }, t); if (!st) return '';
  return `<div style="position:absolute;left:50%;bottom:300px;transform:translateX(-50%);
    opacity:${st.opacity.toFixed(3)};max-width:${Math.round(0.86 * W)}px;text-align:center;
    font-family:${brand.font};font-weight:800;font-size:56px;line-height:1.2;color:#fff;
    background:rgba(0,0,0,.28);padding:14px 28px;border-radius:18px;
    text-shadow:0 3px 18px rgba(0,0,0,.5);">${esc(c.text)}</div>`;
}

// Full transparent frame at time t.
function frameHtml({ overlays = [], captions = [], t = 0, brand }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const parts = [];
  for (const o of overlays) parts.push(o.type === 'image' ? imageOverlay(o, t) : textOverlay(o, t, b));
  for (const c of captions) parts.push(caption(c, t, b));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;}
    html,body{width:${W}px;height:${H}px;background:transparent;overflow:hidden;}
  </style></head><body><div style="position:relative;width:${W}px;height:${H}px;">${parts.join('')}</div></body></html>`;
}

// A standalone gradient background image (used when background.type === 'gradient').
function gradientBgHtml({ colors, brand }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const c1 = (colors && colors[0]) || b.primary;
  const c2 = (colors && colors[1]) || b.accent;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;}</style></head>
    <body style="width:${W}px;height:${H}px;background:linear-gradient(165deg,${c1} 0%, ${c2} 135%);"></body></html>`;
}

module.exports = { frameHtml, gradientBgHtml, W, H, DEFAULT_BRAND };
