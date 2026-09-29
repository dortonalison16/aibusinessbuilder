// HTML templates for rendered social media images, styled with the buyer's brand.
// Sizes: square 1080x1080 (posts/carousels), 4:5 1080x1350 (Meta ads), vertical 1080x1920 (stories).
//
// Look: modern, clean, editorial. Every dark frame is LAYERED (gradient + soft glows + grain +
// vignette) so it never reads as a flat two-color fill; every frame carries the same chrome — a
// small kicker line up top, a big left-aligned hook, a quieter sub, and a brand footer (business
// name, optional handle) with a thin accent rule. System fonts only, so nothing has to be installed.

const DEFAULT_BRAND = {
  primary: '#5b54e6',
  accent: '#19c3b2',
  bg: '#ffffff',
  text: '#1f2430',
  font: '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Roboto, Arial, sans-serif',
};

// Shrink big text as it gets longer, so a long hook still fits the frame instead of being clipped.
function fit(text, base, comfortableChars) {
  const n = String(text || '').length;
  if (n <= comfortableChars) return base;
  return Math.max(Math.round(base * 0.5), Math.round(base * Math.sqrt(comfortableChars / n)));
}

// Rough rendered height of a wrapped text block (px). Bold sans averages ~0.53em per character.
function textHeight(text, size, width, lineHeight, charW = 0.53) {
  const n = String(text || '').length;
  if (!n) return 0;
  const perLine = Math.max(1, Math.floor(width / (size * charW)));
  return Math.ceil(n / perLine) * size * lineHeight;
}

// Headline + sub sized TOGETHER so the pair never overflows the space it has. Starts from fit()
// and steps both down (same proportion) until the estimated stack fits `avail` px.
function fitPair({ headline, sub, headBase, headChars, subBase, subChars, width, avail, gap = 34 }) {
  let hs = fit(headline, headBase, headChars);
  let ss = sub ? fit(sub, subBase, subChars) : 0;
  const total = () => textHeight(headline, hs, width, 1.08) + (sub ? gap + textHeight(sub, ss, width, 1.4, 0.5) : 0);
  for (let i = 0; i < 24 && total() > avail; i++) { hs = Math.max(30, Math.round(hs * 0.93)); ss = Math.max(22, Math.round(ss * 0.93)); }
  return { headSize: hs, subSize: ss };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── color helpers ────────────────────────────────────────────────────────
function hexRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  if (!Number.isFinite(n)) return [90, 84, 230];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => `rgba(${hexRgb(hex).join(',')},${a})`;
function mix(hexA, hexB, amt) { // amt 0 = A, 1 = B
  const a = hexRgb(hexA), b = hexRgb(hexB);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * amt).toString(16).padStart(2, '0')).join('');
}
const darken = (hex, amt) => mix(hex, '#000000', amt);
const lighten = (hex, amt) => mix(hex, '#ffffff', amt);

// Film grain as an inline SVG (no files, no fonts, no network).
const GRAIN = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='260' height='260'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`) + '")';

// Local images are inlined as data: URIs — a page built with setContent() can't load file:// paths.
const dataUriCache = new Map();
function toDataUri(src) {
  if (!src || /^(data:|https?:)/i.test(src)) return src || '';
  if (dataUriCache.has(src)) return dataUriCache.get(src);
  let uri = '';
  try {
    const fs = require('fs');
    const ext = (src.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
    uri = `data:${mime};base64,${fs.readFileSync(src).toString('base64')}`;
  } catch (_) { /* missing file: render without it rather than fail the item */ }
  dataUriCache.set(src, uri);
  return uri;
}

// The layered dark background. `image` (optional path) sits under a brand-tinted scrim so white
// text stays readable on any photo. `seed` nudges the glow positions so a week of posts doesn't
// all share one identical backdrop. `scrim` (0..1, from lib/photo-scrim) is how hard the photo
// needs holding back — a night shot barely needs any, a beach shot needs nearly all of it.
function darkLayers(b, { w, h, image, seed = 0, scrim }) {
  const base = darken(b.primary, 0.42);
  const mid = b.primary;
  const warm = mix(b.primary, b.accent, 0.55);
  const gx = [78, 22, 70, 30][seed % 4], gy = [18, 22, 78, 72][seed % 4];
  const img = image ? toDataUri(image) : '';
  const layers = [];
  if (img) {
    // Bottom-weighted: the top of the frame stays open so the picture reads, and the darkest band
    // sits under the copy and the footer. (A flat scrim used to muddy the whole photo and STILL
    // left white copy short of 4.5:1 on a bright one.)
    const k = Math.max(0, Math.min(1, Number.isFinite(scrim) ? scrim : 0.6));
    const a = (lo, hi) => (lo + (hi - lo) * k).toFixed(2);
    layers.push(`<div style="position:absolute;inset:0;background:url('${img}') center/cover no-repeat;"></div>`);
    layers.push(`<div style="position:absolute;inset:0;background:linear-gradient(180deg,${rgba(base, a(0.06, 0.30))} 0%,${rgba(base, a(0.14, 0.58))} 22%,${rgba(base, a(0.26, 0.86))} 42%,${rgba(base, a(0.34, 0.90))} 72%,${rgba(base, a(0.44, 0.94))} 100%);"></div>`);
    layers.push(`<div style="position:absolute;inset:0;background:${rgba(mid, a(0.05, 0.16))};mix-blend-mode:multiply;"></div>`);
  } else {
    layers.push(`<div style="position:absolute;inset:0;background:
      radial-gradient(circle at ${gx}% ${gy}%, ${rgba(lighten(warm, 0.15), 0.62)} 0%, ${rgba(warm, 0)} 46%),
      radial-gradient(circle at ${100 - gx}% ${100 - gy}%, ${rgba(b.accent, 0.42)} 0%, ${rgba(b.accent, 0)} 52%),
      linear-gradient(158deg, ${base} 0%, ${mid} 48%, ${darken(warm, 0.18)} 100%);"></div>`);
    // A large soft ring — the one "designed" object on the frame; sits behind the copy.
    const r = Math.round(Math.max(w, h) * 0.62);
    layers.push(`<div style="position:absolute;width:${r}px;height:${r}px;border-radius:50%;left:${Math.round(w * (gx / 100)) - r / 2}px;top:${Math.round(h * (gy / 100)) - r / 2}px;border:2px solid rgba(255,255,255,.10);box-shadow:inset 0 0 120px ${rgba(b.accent, 0.12)};"></div>`);
  }
  layers.push(`<div style="position:absolute;inset:0;background-image:${GRAIN};opacity:.16;mix-blend-mode:soft-light;"></div>`);
  layers.push(`<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 52%, rgba(0,0,0,${img ? '.28' : '.42'}) 100%);"></div>`);
  return layers.join('');
}

// Kicker/eyebrow: a small uppercase line with an accent dash. `light` = white on dark.
function kickerHtml(text, b, { size = 26, light = true } = {}) {
  if (!text) return '';
  const col = light ? 'rgba(255,255,255,.88)' : b.primary;
  const dash = light ? b.accent : b.accent;
  return `<div style="display:flex;align-items:center;gap:18px;font-size:${size}px;letter-spacing:.16em;text-transform:uppercase;font-weight:700;color:${col};">
    <span style="display:inline-block;width:44px;height:4px;border-radius:2px;background:${dash};"></span><span>${esc(text)}</span></div>`;
}

// Brand footer: thin accent rule, business name, optional handle (right). Optional logo (left).
function footerHtml(b, { light = true, size = 24 } = {}) {
  const col = light ? 'rgba(255,255,255,.78)' : rgba(b.text, 0.7);
  const rule = light ? 'rgba(255,255,255,.22)' : rgba(b.text, 0.14);
  const logo = b.logo ? toDataUri(b.logo) : '';
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:24px;padding-top:26px;border-top:1px solid ${rule};font-size:${size}px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;color:${col};">
    <div style="display:flex;align-items:center;gap:18px;min-width:0;">
      ${logo ? `<img src="${logo}" style="height:${size * 1.9}px;width:auto;max-width:180px;object-fit:contain;${light ? 'filter:drop-shadow(0 2px 8px rgba(0,0,0,.25));' : ''}"/>` : `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${b.accent};"></span>`}
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(b.name || '')}</span>
    </div>
    ${b.handle ? `<div style="white-space:nowrap;letter-spacing:.06em;text-transform:none;font-weight:600;opacity:.9;">${esc(b.handle)}</div>` : ''}
  </div>`;
}

function base(inner, brand) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;}
    html,body{font-family:${b.font};color:${b.text};-webkit-font-smoothing:antialiased;}
    .frame{position:relative;overflow:hidden;}
    .h{font-family:${b.headFont || b.font};font-weight:800;letter-spacing:-.015em;text-wrap:balance;overflow-wrap:break-word;}
    .p{font-weight:400;overflow-wrap:break-word;}
  </style></head><body>${inner}</body></html>`;
}

// ── carousel ──────────────────────────────────────────────────────────────
// Cover (slide 1) and closer (last slide) are dark brand frames; the middle slides are light
// editorial pages. index/total drive the counter, dots and the "swipe" cue.
function carouselSlide({ title, body, index = 1, total = 1, kicker, brand, background, scrim }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const dark = index === 1 || (total > 1 && index === total);
  const W = 1080, H = 1080, PAD = 88;
  const width = W - PAD * 2;
  const { headSize, subSize } = fitPair({ headline: title, sub: body, headBase: dark ? 80 : 70, headChars: 58, subBase: 38, subChars: 120, width, avail: H - 470 });
  const textCol = dark ? '#fff' : b.text;
  const subCol = dark ? 'rgba(255,255,255,.86)' : rgba(b.text, 0.78);
  const counter = `<div style="font-size:26px;letter-spacing:.14em;font-weight:700;color:${dark ? 'rgba(255,255,255,.7)' : b.primary};">${String(index).padStart(2, '0')}<span style="opacity:.5"> / ${String(total).padStart(2, '0')}</span></div>`;
  const dots = Array.from({ length: total }, (_, i) =>
    `<span style="width:${i === index - 1 ? 34 : 12}px;height:12px;border-radius:6px;background:${i === index - 1 ? (dark ? '#fff' : b.primary) : (dark ? 'rgba(255,255,255,.3)' : rgba(b.primary, 0.22))};display:inline-block;margin-right:8px;"></span>`).join('');
  const cue = index < total
    ? `<div style="font-size:26px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:${dark ? '#fff' : b.primary};display:flex;align-items:center;gap:14px;">swipe <span style="font-size:34px;line-height:1;">→</span></div>`
    : `<div style="font-size:24px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:${dark ? '#fff' : b.primary};display:flex;align-items:center;gap:14px;"><svg width="26" height="30" viewBox="0 0 20 24" style="display:block"><path d="M3 2h14v20l-7-5-7 5z" fill="${dark ? '#fff' : b.primary}"/></svg> save this</div>`;
  const bg = dark ? darkLayers(b, { w: W, h: H, image: background, seed: index, scrim })
    : `<div style="position:absolute;inset:0;background:${b.bg};"></div>
       <div style="position:absolute;inset:0;background:radial-gradient(circle at 88% 8%, ${rgba(b.accent, 0.26)} 0%, ${rgba(b.accent, 0)} 42%);"></div>
       <div style="position:absolute;left:0;top:0;bottom:0;width:14px;background:linear-gradient(180deg,${b.primary},${b.accent});"></div>
       <div style="position:absolute;inset:0;background-image:${GRAIN};opacity:.08;mix-blend-mode:multiply;"></div>`;
  const inner = `<div class="frame" style="width:${W}px;height:${H}px;">
    ${bg}
    <div style="position:absolute;inset:0;padding:${PAD}px ${PAD}px 72px;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;">${kickerHtml(kicker || (index === 1 ? b.name : ''), b, { light: dark })}${counter}</div>
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:40px 0;">
        <div class="h" style="font-size:${headSize}px;line-height:1.06;color:${textCol};${dark ? 'text-shadow:0 2px 24px rgba(0,0,0,.25);' : ''}">${esc(title)}</div>
        ${body ? `<div class="p" style="font-size:${subSize}px;line-height:1.42;color:${subCol};margin-top:34px;max-width:${Math.round(width * 0.92)}px;">${esc(body)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:34px;"><div>${total > 1 ? dots : ''}</div>${total > 1 ? cue : ''}</div>
      ${footerHtml(b, { light: dark })}
    </div>
  </div>`;
  return base(inner, brand);
}

// ── post / meta ad ────────────────────────────────────────────────────────
// A single feed image — kicker, big left-aligned hook, sub, brand footer. Square by default; pass
// height 1350 for a 4:5 image (the shape Meta ads and the Instagram feed show largest). `cta`
// adds a visible pill (Meta ads: "Learn more"). `background` = optional photo path.
function postImage({ headline, sub, kicker, cta, brand, background, width = 1080, height = 1080, seed = 0, scrim }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const PAD = 88;
  const w = width - PAD * 2;
  const chrome = 250 + (cta ? 110 : 0);
  const { headSize, subSize } = fitPair({ headline, sub, headBase: height > width ? 92 : 86, headChars: 52, subBase: 40, subChars: 120, width: w, avail: height - PAD * 2 - chrome });
  const inner = `<div class="frame" style="width:${width}px;height:${height}px;">
    ${darkLayers(b, { w: width, h: height, image: background, seed, scrim })}
    <div style="position:absolute;inset:0;padding:${PAD}px;display:flex;flex-direction:column;">
      ${kickerHtml(kicker || b.name, b)}
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:36px 0;">
        <div class="h" style="font-size:${headSize}px;line-height:1.06;color:#fff;text-shadow:0 2px 28px rgba(0,0,0,.28);">${esc(headline)}</div>
        ${sub ? `<div class="p" style="font-size:${subSize}px;line-height:1.42;color:rgba(255,255,255,.86);margin-top:32px;max-width:${Math.round(w * 0.92)}px;">${esc(sub)}</div>` : ''}
        ${cta ? `<div style="margin-top:44px;"><span style="display:inline-flex;align-items:center;gap:14px;background:#fff;color:${darken(b.primary, 0.2)};font-weight:800;font-size:30px;padding:20px 38px;border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.25);">${esc(cta)} <span style="font-size:34px;line-height:1;">→</span></span></div>` : ''}
      </div>
      ${footerHtml(b)}
    </div>
  </div>`;
  return base(inner, brand);
}

// ── story ─────────────────────────────────────────────────────────────────
// Vertical. Real content in the top area (kicker + hook) instead of an empty block; the sub sits
// in a frosted card. Text stays out of the top ~12% and bottom ~20% where Instagram's UI lives.
function story({ headline, sub, kicker, brand, background, seed = 0, scrim }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const W = 1080, H = 1920, PAD = 84;
  const w = W - PAD * 2;
  const { headSize, subSize } = fitPair({ headline, sub, headBase: 112, headChars: 48, subBase: 50, subChars: 120, width: w - 56, avail: 1000 });
  const inner = `<div class="frame" style="width:${W}px;height:${H}px;">
    ${darkLayers(b, { w: W, h: H, image: background, seed, scrim })}
    <div style="position:absolute;left:0;right:0;top:240px;bottom:330px;padding:0 ${PAD}px;display:flex;flex-direction:column;">
      <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding-bottom:60px;">
        ${kickerHtml(kicker || b.name, b, { size: 30 })}
        <div class="h" style="font-size:${headSize}px;line-height:1.05;color:#fff;margin-top:56px;text-shadow:0 2px 30px rgba(0,0,0,.3);">${esc(headline)}</div>
        ${sub ? `<div style="margin-top:64px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);border-radius:30px;padding:44px 48px;backdrop-filter:blur(14px);box-shadow:0 20px 60px rgba(0,0,0,.18);">
          <div class="p" style="font-size:${subSize}px;line-height:1.42;color:rgba(255,255,255,.94);">${esc(sub)}</div>
        </div>` : ''}
      </div>
      ${footerHtml(b, { size: 26 })}
    </div>
  </div>`;
  return base(inner, brand);
}

// A single still frame of a silent reel (kept for anyone who calls it directly — the video
// renderer draws reel frames with lib/reel-frame.js).
function reelFrame({ lines = [], activeCount = 1, brand }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const shown = lines.slice(0, activeCount).map((ln, i) =>
    `<div class="h" style="font-size:${i === 0 ? 76 : 58}px;line-height:1.15;color:#fff;margin-bottom:30px;opacity:${i === activeCount - 1 ? 1 : 0.8};">${esc(ln)}</div>`).join('');
  const inner = `<div class="frame" style="width:1080px;height:1920px;">
    ${darkLayers(b, { w: 1080, h: 1920 })}
    <div style="position:absolute;left:0;right:0;top:260px;padding:0 96px;">${kickerHtml(b.name, b)}<div style="height:60px"></div>${shown}</div>
  </div>`;
  return base(inner, brand);
}

module.exports = { carouselSlide, postImage, story, reelFrame, DEFAULT_BRAND, fit, fitPair, darkLayers, kickerHtml, footerHtml, toDataUri, rgba, mix, darken, lighten, GRAIN, esc };
