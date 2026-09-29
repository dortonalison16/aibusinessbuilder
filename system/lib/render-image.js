// Renders an HTML string to a PNG at an exact size (for carousels, stories, posts).
// Resolves Puppeteer from the local install first; falls back to a sibling install at build time.
const path = require('path');

function loadPuppeteer() {
  try { return require('puppeteer'); }
  catch (_) { throw new Error('Puppeteer not found. Run "npm install" in the system folder.'); }
}

// renderHtmlToPng({ html, width, height, outPath, scale })
async function renderHtmlToPng({ html, width, height, outPath, scale = 2, transparent = false }, sharedBrowser) {
  const puppeteer = loadPuppeteer();
  const browser = sharedBrowser || (await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] }));
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width, height }, omitBackground: transparent });
    await page.close();
    return outPath;
  } finally {
    if (!sharedBrowser) await browser.close();
  }
}

// Render many at once on one browser instance (faster for a batch).
async function renderBatch(jobs) {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const out = [];
    for (const job of jobs) out.push(await renderHtmlToPng(job, browser));
    return out;
  } finally {
    await browser.close();
  }
}

module.exports = { renderHtmlToPng, renderBatch, loadPuppeteer };
