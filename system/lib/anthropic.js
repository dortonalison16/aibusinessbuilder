// Minimal Anthropic Messages API client (no SDK dependency) for the auto-writer.
// Uses the buyer's own ANTHROPIC_API_KEY from .env.
const https = require('https');
const { loadEnv } = require('./telegram');

const MODEL = 'claude-sonnet-4-6'; // good quality + cost for content writing

function hasKey(env) { return Boolean((env || loadEnv()).ANTHROPIC_API_KEY); }

// `search: true` enables Claude's built-in web search tool, which is how the weekly research step
// gets current trends. Deliberately reuses the buyer's existing ANTHROPIC_API_KEY rather than
// adding a scraping vendor — no second signup, no second bill, no extra dependency to install.
function askClaude(prompt, { env, maxTokens = 4000, model = MODEL, search = false, maxSearches = 5 } = {}) {
  const e = env || loadEnv();
  const key = e.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    if (!key) return resolve({ ok: false, reason: 'no-key' });
    const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    if (search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }];
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = ''; res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode !== 200) return resolve({ ok: false, reason: `api-${res.statusCode}`, message: json.error && json.error.message });
          const text = (json.content || []).map((b) => b.text || '').join('');
          resolve({ ok: true, text });
        } catch (err) { resolve({ ok: false, reason: 'parse', message: err.message }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, reason: 'network', message: err.message }));
    req.write(payload); req.end();
  });
}

// Pull the first JSON array/object out of a model response (handles ```json fences).
function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.search(/[[{]/);
  if (start === -1) return null;
  for (let end = raw.length; end > start; end--) {
    try { return JSON.parse(raw.slice(start, end)); } catch (_) {}
  }
  return null;
}

module.exports = { askClaude, extractJson, hasKey, MODEL };
