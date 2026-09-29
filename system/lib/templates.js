// HTML templates for rendered social media images, styled with the buyer's brand colours.
// Sizes: square 1080x1080 (posts/carousels), vertical 1080x1920 (stories).

const DEFAULT_BRAND = {
  primary: '#5b54e6',
  accent: '#19c3b2',
  bg: '#ffffff',
  text: '#1f2430',
  font: '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function base(inner, brand) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;}
    html,body{font-family:${b.font};color:${b.text};}
    .frame{position:relative;overflow:hidden;}
  </style></head><body>${inner}</body></html>`;
}

// One carousel slide (square). index/total drive the little progress dots.
function carouselSlide({ title, body, index = 1, total = 1, kicker, brand }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const dots = Array.from({ length: total }, (_, i) =>
    `<span style="width:14px;height:14px;border-radius:50%;background:${i === index - 1 ? b.primary : '#d7dbe7'};display:inline-block;margin:0 5px;"></span>`).join('');
  const inner = `<div class="frame" style="width:1080px;height:1080px;background:${b.bg};padding:96px 88px;display:flex;flex-direction:column;">
    <div style="height:10px;width:120px;background:${b.accent};border-radius:6px;margin-bottom:40px;"></div>
    ${kicker ? `<div style="font-size:30px;letter-spacing:.12em;text-transform:uppercase;color:${b.primary};font-weight:700;margin-bottom:24px;">${esc(kicker)}</div>` : ''}
    <div style="font-size:74px;line-height:1.08;font-weight:800;color:${b.text};">${esc(title)}</div>
    ${body ? `<div style="font-size:40px;line-height:1.4;color:${b.text};opacity:.82;margin-top:34px;">${esc(body)}</div>` : ''}
    <div style="margin-top:auto;display:flex;align-items:center;justify-content:space-between;">
      <div>${total > 1 ? dots : ''}</div>
      ${index < total ? `<div style="font-size:34px;font-weight:700;color:${b.primary};">swipe →</div>` : ''}
    </div>
  </div>`;
  return base(inner, brand);
}

// A single feed post image (square) — big hook with an accent bar.
function postImage({ headline, sub, brand }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const inner = `<div class="frame" style="width:1080px;height:1080px;background:linear-gradient(135deg,${b.primary} 0%, ${b.accent} 140%);padding:110px 90px;display:flex;flex-direction:column;justify-content:center;">
    <div style="font-size:80px;line-height:1.1;font-weight:800;color:#fff;">${esc(headline)}</div>
    ${sub ? `<div style="font-size:42px;line-height:1.4;color:#fff;opacity:.92;margin-top:36px;">${esc(sub)}</div>` : ''}
  </div>`;
  return base(inner, brand);
}

// A story (vertical) — image-forward template with a headline band.
function story({ headline, sub, brand }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const inner = `<div class="frame" style="width:1080px;height:1920px;background:${b.bg};display:flex;flex-direction:column;">
    <div style="flex:1;background:linear-gradient(160deg,${b.primary} 0%, ${b.accent} 130%);"></div>
    <div style="background:${b.bg};padding:90px 80px 130px;">
      <div style="height:12px;width:140px;background:${b.accent};border-radius:6px;margin-bottom:40px;"></div>
      <div style="font-size:82px;line-height:1.1;font-weight:800;color:${b.text};">${esc(headline)}</div>
      ${sub ? `<div style="font-size:44px;line-height:1.4;color:${b.text};opacity:.8;margin-top:34px;">${esc(sub)}</div>` : ''}
    </div>
  </div>`;
  return base(inner, brand);
}

// A single frame of a silent reel. `lines` is the full text stack; `activeCount` lines are shown
// (accumulating top-to-bottom, no-loop style). Bottom third kept clear ("face-clear" zone).
function reelFrame({ lines = [], activeCount = 1, brand }) {
  const b = { ...DEFAULT_BRAND, ...(brand || {}) };
  const shown = lines.slice(0, activeCount).map((ln, i) =>
    `<div style="font-size:72px;line-height:1.18;font-weight:800;color:#fff;margin-bottom:30px;
       opacity:${i === activeCount - 1 ? 1 : 0.92};">${esc(ln)}</div>`).join('');
  const inner = `<div class="frame" style="width:1080px;height:1920px;
      background:linear-gradient(165deg,${b.primary} 0%, ${b.accent} 135%);padding:200px 96px 0;
      display:flex;flex-direction:column;">
    <div style="height:12px;width:150px;background:#ffffff;opacity:.85;border-radius:6px;margin-bottom:60px;"></div>
    ${shown}
  </div>`;
  return base(inner, brand);
}

module.exports = { carouselSlide, postImage, story, reelFrame, DEFAULT_BRAND };
