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
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message, data: null }));
    req.end();
  });
}

// Format cents → "$12.34" (or other currency code).
function money(amount, currency) {
  const v = (Number(amount || 0) / 100).toFixed(2);
  if (!currency || currency.toLowerCase() === 'usd') return `$${v}`;
  return `${v} ${String(currency).toUpperCase()}`;
}

module.exports = { stripeGet, money };
