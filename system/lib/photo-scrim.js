// How much a photo (or a clip frame) needs holding back before white copy sits on it.
// A fixed scrim can't serve every picture: heavy enough for a bright beach shot, it turns a moody
// evening photo into a black wall — and the old flat one still fell short of 4.5:1 on bright photos.
// So the renderers sample the picture once (mean luminance of the band the copy sits in, cover-fit
// like the CSS background) and pass a strength 0..1 to the templates' bottom-weighted gradient.
const tpl = require('./templates');

const DEFAULT_STRENGTH = 0.6; // when the picture can't be read (missing/corrupt): a middle scrim

// Mean relative luminance (0..1, sRGB-linear) of the copy zone of `src` when cover-fitted to a
// width x height frame. Uses the shared puppeteer browser; returns null if the image won't decode.
async function photoLuminance(src, browser, { width = 1080, height = 1080 } = {}) {
  const uri = tpl.toDataUri(src);
  if (!uri || !browser) return null;
  let page;
  try {
    page = await browser.newPage();
    return await page.evaluate(async (uri, w, h) => {
      const img = new Image(); img.src = uri; await img.decode();
      const W = 96, H = Math.max(8, Math.round((96 * h) / w));
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      const y0 = Math.round(H * 0.22), y1 = Math.round(H * 0.88);
      const d = g.getImageData(0, y0, W, Math.max(1, y1 - y0)).data;
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { sum += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]); n++; }
      return n ? sum / n : null;
    }, uri, width, height);
  } catch (_) {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Luminance -> scrim strength. Calibrated by measuring the average pixel behind the headline: this
// line puts white 800-weight copy at ~6.5:1 (WCAG asks 4.5:1) on a near-white photo (0.87 -> 0.72),
// a mid daytime one (0.43 -> 0.43) and leaves a night shot almost untouched (0.03 -> 0.17), which
// still measures well over 14:1.
function scrimStrength(lum) {
  if (!Number.isFinite(lum)) return DEFAULT_STRENGTH;
  return Math.max(0.15, Math.min(0.85, 0.15 + lum * 0.65));
}

// One call for the renderers: strength for `src`, cached per path for the length of a run.
const cache = new Map();
async function scrimFor(src, browser, size) {
  if (!src) return undefined;
  const key = `${src}|${(size && size.width) || 0}x${(size && size.height) || 0}`;
  if (!cache.has(key)) cache.set(key, scrimStrength(await photoLuminance(src, browser, size)));
  return cache.get(key);
}

module.exports = { photoLuminance, scrimStrength, scrimFor, DEFAULT_STRENGTH };
