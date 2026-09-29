// The buyer's brand for rendered content, read from client-config.md "## Brand & Look".
//
// guided-setup describes palettes in plain words ("a warm blush pink, a deep confident plum, and
// soft cream") because non-technical people freeze on hex codes. So: use hex codes if the section
// has any (e.g. a "Hex codes:" line), otherwise translate the color words, otherwise defaults.
// The same section also names the business ("Business name:"), an optional "Handle:", a "Font
// feeling:" and a "Logo file:" — all optional, all used only to dress the rendered images.
const fs = require('fs');
const path = require('path');
const { getConfigSection, getConfigValue, ROOT } = require('./config');

// Plain-word colors people actually use for brands → a tasteful hex. Longest phrase wins.
const WORDS = {
  'blush pink': '#e8a0a8', blush: '#e8a0a8', 'dusty rose': '#c98b8f', rose: '#d0697a', pink: '#e36f9a', 'hot pink': '#e0457b',
  coral: '#f07a62', peach: '#f4a987', terracotta: '#c8674a', rust: '#b5532e', orange: '#f08a2c', 'burnt orange': '#cc5a1e',
  mustard: '#d9a929', gold: '#c9a13b', yellow: '#f2c230', butter: '#f5dc86', cream: '#f7efe2', ivory: '#fbf6ec', beige: '#e8dcc8', sand: '#dcc7a4',
  sage: '#8fa98b', 'sage green': '#8fa98b', olive: '#7d8445', 'forest green': '#2f5d46', emerald: '#1e8a5f', mint: '#9fdcc2', green: '#3f9a5e',
  teal: '#19a3a0', turquoise: '#29b8b0', aqua: '#4fd1d9', 'sky blue': '#7cc3ea', 'baby blue': '#a9d4f2', blue: '#3b6fe0', 'royal blue': '#2a4fc4',
  navy: '#1f2f5c', 'navy blue': '#1f2f5c', 'midnight blue': '#1b2448', indigo: '#4b3fb3', periwinkle: '#8d93e0',
  lavender: '#b7a3e3', lilac: '#c4a4d8', purple: '#7a4fc9', violet: '#7d48d4', plum: '#6b2d5c', 'deep plum': '#5a2350', mauve: '#b07d9b', berry: '#8e2f5e',
  burgundy: '#7a1f35', wine: '#6e1f33', maroon: '#6d1a2a', red: '#d8433f', crimson: '#b8203b',
  charcoal: '#33373f', black: '#1c1c1e', slate: '#5a6472', grey: '#8a8f98', gray: '#8a8f98', white: '#ffffff', taupe: '#9c8b7a', brown: '#7a5234', chocolate: '#5b3a24',
};

function parseColors(text) {
  const t = String(text || '').toLowerCase();
  const hexes = t.match(/#[0-9a-f]{6}\b/g) || [];
  if (hexes.length) return hexes;
  const found = [];
  const phrases = Object.keys(WORDS).sort((a, b) => b.length - a.length);
  let rest = t;
  for (const p of phrases) {
    const re = new RegExp(`\\b${p}\\b`, 'g');
    let m;
    while ((m = re.exec(rest))) { found.push({ at: m.index, hex: WORDS[p] }); }
    rest = rest.replace(re, ' '.repeat(p.length)); // so "sage" doesn't re-match inside "sage green"
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.hex);
}

// Relative luminance, to keep light colors (cream, ivory) from being used as the main fill.
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// One labeled line of the section ("Business name: Her First Win Co"). Template leftovers such as
// "(e.g. …)" or "none yet" are not values.
function field(section, label) {
  const re = new RegExp(`^${label}[^:\\n]*:\\s*(.+)$`, 'im');
  const m = String(section || '').match(re);
  const v = m ? m[1].trim() : '';
  if (!v || /^\(.*\)$/.test(v) || /^(none|none yet|n\/a|tbd|-)$/i.test(v)) return '';
  return v;
}

// The product name without its tagline: "Her First Win — From Stuck to Started (title + tagline)"
// -> "Her First Win".
function shortProductName() {
  const raw = getConfigValue('Name', '') || '';
  return raw.split(/\s+[—–-]\s+|\s*\(|:\s/)[0].trim();
}

function brandFromConfig(defaults) {
  const b = { ...defaults };
  const section = getConfigSection('Brand & Look', '');
  const colors = parseColors(section);
  // Darkest color leads: rendered headlines are white, so the main fill needs the contrast.
  const strong = colors.filter((c) => lum(c) < 0.6).sort((a, b) => lum(a) - lum(b));
  const light = colors.filter((c) => lum(c) >= 0.6);
  if (strong[0]) b.primary = strong[0];
  if (strong[1]) b.accent = strong[1];
  else if (light[0] && strong[0]) b.accent = light[0];
  if (light[0] && 'bg' in b) b.bg = light[0];

  // Brand chrome for the rendered images (all optional in the config).
  b.name = field(section, 'Business name') || shortProductName();
  const handle = field(section, 'Handle').replace(/^https?:\/\/\S+\//, '');
  b.handle = handle ? (handle.startsWith('@') ? handle : '@' + handle) : '';
  const feel = field(section, 'Font feeling').toLowerCase();
  // System fonts only — nothing has to be installed. "Classic/elegant" gets serif headlines.
  if (/classic|elegant|serif|editorial|luxur/.test(feel)) b.headFont = "Georgia, 'Times New Roman', 'Iowan Old Style', serif";
  const logo = field(section, 'Logo file');
  if (logo) {
    const p = path.isAbsolute(logo) ? logo : path.join(ROOT, logo);
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(p) && fs.existsSync(p)) b.logo = p;
  }
  return b;
}

module.exports = { brandFromConfig, parseColors, lum };
