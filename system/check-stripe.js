// Validates the user's own Stripe key by asking Stripe "who am I?" (GET /v1/account).
// No charges, no changes — just confirms the key works. Read-only and safe.

const https = require('https');
const { loadEnv } = require('./lib/telegram');

function getStripeAccount(key) {
  const options = {
    hostname: 'api.stripe.com',
    path: '/v1/account',
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('timed out after 30s'))); // a stalled connection must not hang a scheduled job
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.end();
  });
}

(async () => {
  const env = loadEnv();
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    console.log('NOT CONNECTED: No Stripe key found in .env yet. Paste the secret key, then run this again.');
    process.exitCode = 1;
    return;
  }
  const res = await getStripeAccount(key);
  if (res.status === 200) {
    let label = '';
    try {
      const acct = JSON.parse(res.body);
      label = acct.email || acct.id || '';
    } catch (_) {}
    const mode = key.startsWith('sk_live') ? 'LIVE (real payments)' : 'TEST (practice mode)';
    console.log(`SUCCESS: Stripe connected ✅  Mode: ${mode}${label ? `  Account: ${label}` : ''}`);
  } else if (res.status === 401) {
    console.log('KEY REJECTED: Stripe says that key is not valid. Double-check you copied the whole secret key.');
    process.exitCode = 1;
  } else {
    console.log(`COULD NOT VERIFY (status ${res.status}). Check internet and the key, then try again.`);
    process.exitCode = 1;
  }
})();
