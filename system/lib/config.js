// Reads simple values out of the shared client-config.md and finds the built product file.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readConfigText() {
  const p = path.join(ROOT, 'client-config.md');
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

// Grab the first "- ..." bullet under a "## Section" heading.
function getConfigValue(section, fallback) {
  const text = readConfigText();
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase());
  if (idx === -1) return fallback;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ')) return l.slice(2).trim();
  }
  return fallback;
}

// Find the finished product file to deliver (prefer PDF, then HTML).
function findProductFile() {
  const dir = path.join(ROOT, 'Product');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const pdf = files.find((f) => f.toLowerCase().endsWith('.pdf'));
  if (pdf) return path.join(dir, pdf);
  const html = files.find((f) => f.toLowerCase().endsWith('.html'));
  if (html) return path.join(dir, html);
  return null;
}

module.exports = { getConfigValue, findProductFile, ROOT };
