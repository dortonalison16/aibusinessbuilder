// Uploads a local image to a public URL — needed because Instagram's API can only post images
// from a public URL (it can't take a local file). Uses imgbb (free API key) by default.
// The buyer adds their own IMGBB_API_KEY in .env. If absent, hosting is skipped (and IG posting
// of rendered images is left for manual posting, while Facebook can still upload directly).

const https = require('https');
const fs = require('fs');
const { loadEnv } = require('./telegram');

function hostingConfigured(env) { return Boolean((env || loadEnv()).IMGBB_API_KEY); }

// Returns { ok, url } or { ok:false, reason }.
function hostImage(filePath, env) {
  const e = env || loadEnv();
  const key = e.IMGBB_API_KEY;
  return new Promise((resolve) => {
    if (!key) return resolve({ ok: false, reason: 'no-host-key' });
    let b64;
    try { b64 = fs.readFileSync(filePath).toString('base64'); } catch (err) { return resolve({ ok: false, reason: 'read-failed', message: err.message }); }
    const body = 'image=' + encodeURIComponent(b64);
    const req = https.request({
      hostname: 'api.imgbb.com', path: `/1/upload?key=${encodeURIComponent(key)}`, method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''; res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json && json.success && json.data && json.data.url) return resolve({ ok: true, url: json.data.url });
          resolve({ ok: false, reason: `host-${res.statusCode}`, message: json && json.error && json.error.message });
        } catch (err) { resolve({ ok: false, reason: 'parse', message: err.message }); }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('timed out after 120s'))); // a stalled connection must not hang a scheduled job
    req.on('error', (err) => resolve({ ok: false, reason: 'network', message: err.message }));
    req.write(body); req.end();
  });
}

module.exports = { hostImage, hostingConfigured };
