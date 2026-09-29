// Telegram sender — plain text only (rich formatting can silently fail to deliver).
// Reads the user's own bot token + chat id from their .env. Never hard-coded.

const https = require('https');

function loadEnv() {
  // Tiny .env reader so we don't need an extra dependency.
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '..', '.env');
  const out = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}

// Send a plain-text Telegram message. Returns a promise that resolves true/false.
function sendTelegram(text, env) {
  const e = env || loadEnv();
  const token = e.TELEGRAM_BOT_TOKEN;
  const chatId = e.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('Telegram not connected yet (no token/chat id) — skipping message.');
    return Promise.resolve(false);
  }
  const payload = JSON.stringify({ chat_id: chatId, text: String(text) }); // plain text, no parse_mode
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        const ok = res.statusCode === 200;
        if (!ok) console.log(`Telegram error (${res.statusCode}): ${body}`);
        resolve(ok);
      });
    });
    req.on('error', (err) => {
      console.log(`Telegram request failed: ${err.message}`);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendTelegram, loadEnv };
