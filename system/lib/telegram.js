// Telegram sender — plain text only (rich formatting can silently fail to deliver).
// Reads the user's own bot token + chat id from their .env. Never hard-coded.

const https = require('https');

// Parse one value from a .env line. Handles the three ways a hand-edited (or Windows-saved) .env
// goes wrong: a trailing "# comment" after the value, surrounding quotes, and the invisible \r a
// Windows editor leaves at the end of every line (which Node rejects inside an HTTP header).
function parseEnvValue(raw) {
  let v = String(raw || '').replace(/\r/g, '').trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    return v.slice(1, -1);
  }
  if (v.startsWith('#')) return ''; // "KEY=   # explanation" means the key is blank
  const hash = v.search(/\s#/); // an inline comment needs whitespace before the #
  if (hash !== -1) v = v.slice(0, hash);
  return v.trim();
}

function loadEnv() {
  // Tiny .env reader so we don't need an extra dependency.
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '..', '.env');
  const out = {};
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8').replace(/^﻿/, ''); // Notepad can add a BOM
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
      if (!m) continue;
      const v = parseEnvValue(m[2]);
      if (v !== '') out[m[1]] = v; // blank = not set, so "X || default" fallbacks work everywhere
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
        // No raw JSON body: the owner reads this in a log, and the status code is enough for the assistant.
        if (!ok) console.log(`Phone message not sent (Telegram status ${res.statusCode}) — Telegram rejected the bot token or chat ID; fix it on the connect page.`);
        resolve(ok);
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('timed out after 30s'))); // a stalled connection must not hang a scheduled job
    req.on('error', (err) => {
      console.log(`Telegram request failed: ${err.message}`);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendTelegram, loadEnv, parseEnvValue };
