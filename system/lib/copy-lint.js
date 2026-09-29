// Copy checks that run on every piece the unattended writer produces — a guarantee, not a request.
// A prompt can ASK the model not to write an income claim; only a check after the fact can make
// sure one never gets posted. Two kinds of result:
//   - fixed silently: hashtags trimmed to 4 on Instagram/Facebook (5+ reads as spam and cuts reach)
//   - flagged for the owner: anything that looks like an earnings claim, a guarantee, or one of the
//     owner's own banned words. Flagged items are held (status "needs-review") and never posted
//     until the owner looks at them.
const { getConfigSection } = require('./config');

// Earnings / guarantee language that gets ad accounts and posts restricted — and isn't honest.
const CLAIM_PATTERNS = [
  [/\$\s?\d[\d,.]*\s?(k|K)?\s*(\/|per|a|an|every)\s*(day|week|month|year|mo|yr|hour|hr)\b/, 'money-per-time figure'],
  [/\b(make|made|earn|earned|earning|making|pull(ed)? in|generate[ds]?|bring(s)? in)\s+(over\s+|up to\s+|about\s+)?\$\s?\d/i, 'earnings figure'],
  [/\b\d[\d,.]*\s?(k|K)\s*(\/|per|a)\s*(month|mo|year)\b/, 'earnings figure'],
  [/\b(six|seven|6|7)[- ]figures?\b/i, '"six figures"-style claim'],
  [/\bpassive income\b/i, '"passive income"'],
  [/\bguarantee[ds]?\b/i, 'guarantee (other than a refund guarantee)', { skipSentence: /refund|money[- ]back/i }],
  [/\bget rich\b|\brich quick\b|\bfinancial freedom\b|\breplace your (salary|income|paycheck)\b|\bquit your (job|9[- ]?to[- ]?5)\b/i, 'get-rich / quit-your-job promise'],
  [/\b(risk[- ]free|no risk|can'?t lose|overnight success)\b/i, 'no-risk promise'],
];

function ownerBannedWords() {
  const block = getConfigSection('Banned words', '') || '';
  return block.split(/[\n,]/).map((w) => w.replace(/^[-*]\s*/, '').trim()).filter((w) => w && w.length < 40);
}

// Keep at most `cap` hashtags; removes the extras from the END (the first ones are usually the core tags).
function capHashtags(text, cap = 4) {
  let seen = 0;
  return String(text || '').replace(/(^|\s)#[\p{L}\p{N}_]+/gu, (m) => (++seen > cap ? '' : m)).replace(/[ \t]+\n/g, '\n').trim();
}

function textOf(item) {
  const slides = Array.isArray(item.slides) ? item.slides : [];
  return [item.caption, item.headline, item.sub, item.script, item.igCut,
    ...[].concat(item.textStack || []), ...slides.flatMap((s) => (s ? [s.kicker, s.title, s.body] : []))]
    .filter(Boolean).join('\n');
}

// Returns { item, fixes: [...], problems: [...] } — the item is changed in place for fixes only.
function lintItem(item) {
  const fixes = [];
  const problems = [];
  const platform = String(item.platform || '').toLowerCase();
  if (item.caption && (platform === 'instagram' || platform === 'facebook' || !platform)) {
    const capped = capHashtags(item.caption, 4);
    if (capped !== String(item.caption).trim()) { item.caption = capped; fixes.push('trimmed hashtags to 4'); }
  }
  const text = textOf(item);
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const [re, label, opts] of CLAIM_PATTERNS) {
    // A refund / money-back guarantee is an honest promise, so those sentences are exempt.
    const pool = opts && opts.skipSentence ? sentences.filter((s) => !opts.skipSentence.test(s)) : [text];
    if (pool.some((s) => re.test(s))) problems.push(label);
  }
  const lower = text.toLowerCase();
  for (const w of ownerBannedWords()) if (lower.includes(w.toLowerCase())) problems.push(`your banned word "${w}"`);
  const hook = (item.textStack && item.textStack[0]) || item.headline || '';
  if (hook && hook.split(/\s+/).length > 12) fixes.push('hook is long (over 12 words) — consider tightening');
  return { item, fixes, problems: [...new Set(problems)] };
}

module.exports = { lintItem, capHashtags, CLAIM_PATTERNS };
