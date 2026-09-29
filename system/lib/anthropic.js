// Minimal Anthropic Messages API client (no SDK dependency) for the unattended writer + research.
// Uses the buyer's own ANTHROPIC_API_KEY from .env. Deliberately dependency-free so it works on a
// buyer's laptop before (or without) any extra install.
//
// Reliability (an unattended weekly job that fails once loses a whole week of content):
//   - retries 429 / 529 overloaded / 5xx / network errors with backoff, honoring retry-after
//   - continues a web-search turn the API paused (stop_reason "pause_turn")
//   - reports a truncated answer (stop_reason "max_tokens") instead of pretending it's complete
const https = require('https');
const { loadEnv } = require('./telegram');

// Sonnet tier: good quality at a sensible cost for weekly writing. Override with ANTHROPIC_MODEL.
const MODEL = 'claude-sonnet-5';
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 5;

function hasKey(env) { return Boolean((env || loadEnv()).ANTHROPIC_API_KEY); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One raw POST /v1/messages. Resolves { status, headers, json } or { status: 0, error }.
function post(body, key) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 10 * 60 * 1000,
    }, (res) => {
      let data = ''; res.on('data', (d) => (data += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.write(payload); req.end();
  });
}

// POST with retries. Returns the final raw result.
async function postWithRetry(body, key) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await post(body, key);
    const retryable = last.status === 0 || RETRYABLE.has(last.status);
    if (!retryable || attempt === MAX_ATTEMPTS) return last;
    const ra = Number(last.headers && last.headers['retry-after']);
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 120000) : Math.min(2000 * 2 ** (attempt - 1), 60000);
    console.log(`(Claude is busy — status ${last.status || 'network'} — trying again in ${Math.round(wait / 1000)}s…)`);
    await sleep(wait);
  }
  return last;
}

// `search: true` enables Claude's built-in web search tool, which is how the weekly research step
// gets current trends. Deliberately reuses the buyer's existing ANTHROPIC_API_KEY rather than
// adding a scraping vendor — no second signup, no second bill, no extra dependency to install.
async function askClaude(prompt, { env, maxTokens = 16000, model, search = false, maxSearches = 5, system } = {}) {
  const e = env || loadEnv();
  const key = e.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, reason: 'no-key' };
  const useModel = model || e.ANTHROPIC_MODEL || MODEL;

  const messages = [{ role: 'user', content: prompt }];
  const body = { model: useModel, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (search) body.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }];

  let text = '';
  for (let turn = 0; turn < 4; turn++) {
    const res = await postWithRetry(body, key);
    if (res.status !== 200 || !res.json) {
      const msg = res.error || (res.json && res.json.error && res.json.error.message) || '';
      return { ok: false, reason: res.status ? `api-${res.status}` : 'network', message: msg };
    }
    const json = res.json;
    text += (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (json.stop_reason === 'pause_turn') {
      // A long web-search turn was paused server-side: send it back as-is and let it continue.
      messages.push({ role: 'assistant', content: json.content });
      continue;
    }
    if (json.stop_reason === 'refusal') return { ok: false, reason: 'refusal', message: 'Claude declined this request.' };
    return { ok: true, text, truncated: json.stop_reason === 'max_tokens', stopReason: json.stop_reason };
  }
  return { ok: true, text, truncated: true, stopReason: 'pause_turn' };
}

// Scan from an opening [ or { to its matching close, ignoring brackets inside strings.
// Returns { end } (index of the close) or { end: -1, cuts } where `cuts` are the indexes right after
// each complete top-level element of an array that was cut off.
function scanJson(raw, start) {
  let depth = 0, inStr = false, esc = false;
  const cuts = [];
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return { end: i }; if (depth === 1) cuts.push(i + 1); }
  }
  return { end: -1, cuts };
}

// Pull the first JSON array/object out of a model response (handles ```json fences, prose around the
// JSON — even prose containing brackets — and an answer cut off mid-array, keeping its complete items).
// `kind`: 'object' or 'array' (of objects) skips valid-but-wrong JSON such as a "[1]" citation marker
// in web-search prose, which otherwise wins because it comes first.
function extractJson(text, kind) {
  if (!text) return null;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const wanted = (v) => (kind === 'object' ? isObj(v) : kind === 'array' ? Array.isArray(v) && v.some(isObj) : true);
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  for (const raw of fence ? [fence[1], text] : [text]) {
    for (let i = raw.search(/[[{]/); i !== -1 && i < raw.length; i++) {
      if (raw[i] !== '[' && raw[i] !== '{') continue;
      if (kind === 'object' && raw[i] !== '{') continue;
      const s = scanJson(raw, i);
      if (s.end !== -1) {
        try { const v = JSON.parse(raw.slice(i, s.end + 1)); if (wanted(v)) return v; } catch (_) { /* not JSON: keep looking */ }
        continue;
      }
      if (raw[i] === '[') {
        for (const cut of s.cuts.reverse()) {
          try { const items = JSON.parse(raw.slice(i, cut) + ']'); if (items.length) return items; } catch (_) {}
        }
      }
      break; // unclosed and unsalvageable: anything later is inside it
    }
  }
  return null;
}

module.exports = { askClaude, extractJson, hasKey, MODEL };
