// Minimal Stripe GET helper — reads the user's own key from .env. Read-only calls only.
const https = require('https');
const { loadEnv } = require('./telegram');

function stripeGet(path, env) {
  const e = env || loadEnv();
  const key = e.STRIPE_SECRET_KEY;
  return new Promise((resolve) => {
    if (!key) return resolve({ ok: false, status: 0, error: 'no-key', data: null });
    const options = {
      hostname: 'api.stripe.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({ ok: res.statusCode === 200, status: res.statusCode, data: json, raw: body });
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('timed out after 60s'))); // a stalled connection must not hang a scheduled job
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message, data: null }));
    req.end();
  });
}

// Format cents → "$12.34" (or other currency code).
// Stripe's zero-decimal currencies are already in whole units (¥500 is 500, not 50000).
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
function money(amount, currency) {
  const zero = ZERO_DECIMAL.has(String(currency || '').toLowerCase());
  const v = zero ? String(Math.round(Number(amount || 0))) : (Number(amount || 0) / 100).toFixed(2);
  if (!currency || currency.toLowerCase() === 'usd') return `$${v}`;
  return `${v} ${String(currency).toUpperCase()}`;
}

module.exports = { stripeGet, money };
