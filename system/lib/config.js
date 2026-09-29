// Reads simple values out of the shared client-config.md and finds the built product file.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readConfigText() {
  const p = path.join(ROOT, 'client-config.md');
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

// An unfilled template bullet like "- (live comment keywords and what each sends…)" is not a value —
// reading it as one made the writer treat the template's example keyword as a live CTA.
const isPlaceholder = (l) => /^-\s*\(.*\)\s*$/.test(l);

// Grab the first "- ..." bullet under a "## Section" heading.
function getConfigValue(section, fallback) {
  const text = readConfigText();
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase());
  if (idx === -1) return fallback;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ') && !isPlaceholder(l)) return l.slice(2).trim();
  }
  return fallback;
}

// ALL the "- ..." bullets under a "## Section" heading, joined into one block. Use this whenever the
// whole section matters (voice, audience, brand) — getConfigValue only returns the first bullet,
// which for "Story / Voice" is the background and silently drops the voice notes.
function getConfigSection(section, fallback = '') {
  const lines = readConfigText().split('\n');
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase());
  if (idx === -1) return fallback;
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ') && !isPlaceholder(l)) out.push(l.slice(2).trim());
  }
  return out.length ? out.join('\n') : fallback;
}

// One labeled bullet inside a section, e.g. getConfigField('Transformation', 'One-liner').
function getConfigField(section, label, fallback = '') {
  const block = getConfigSection(section, '');
  const re = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+)$`, 'im');
  const m = block.match(re);
  return m ? m[1].trim() : fallback;
}

// The ONE rule for which file gets emailed to a buyer — shared by delivery, the health check and the
// connect page so they always agree. Only a single PDF qualifies:
//   - an HTML file can't be emailed (its images don't travel as an attachment)
//   - with two PDFs we'd be guessing which is the finished one, so we refuse instead
// Hidden/temp files (e.g. "~$guide.pdf" lock files) are ignored. Returns { file } or { file: null,
// problem: 'none' | 'many' | 'html', message }.
function productFileStatus() {
  const dir = path.join(ROOT, 'Product');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith('.') && !f.startsWith('~$')) : [];
  const pdfs = files.filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 1) return { file: path.join(dir, pdfs[0]) };
  if (pdfs.length > 1) {
    return { file: null, problem: 'many', message: `There's more than one PDF in the Product folder (${pdfs.join(', ')}) — keep only the finished one there, or set a download link (PRODUCT_DOWNLOAD_URL).` };
  }
  if (files.some((f) => /\.html?$/i.test(f))) {
    return { file: null, problem: 'html', message: 'The Product folder has an HTML file but no PDF — an HTML file can\'t be emailed (its images don\'t travel with it). Save it as a PDF, or set a download link (PRODUCT_DOWNLOAD_URL).' };
  }
  return { file: null, problem: 'none', message: 'No product to send yet — there is no PDF in the Product folder and no PRODUCT_DOWNLOAD_URL set.' };
}

function findProductFile() { return productFileStatus().file; }

module.exports = { getConfigValue, getConfigSection, getConfigField, findProductFile, productFileStatus, ROOT };
