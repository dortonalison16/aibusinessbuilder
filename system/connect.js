// The connect page — a small local web page where the owner pastes each key into a card and
// clicks Save & test. It saves everything into their private .env (on their computer only), so nobody ever
// edits a settings file by hand or pastes a secret into a chat.
//
//   node system/connect.js            opens http://localhost:4848/?t=<one-time token>
//   node system/connect.js --no-open  print the address instead of opening the browser
//
// Safety:
//   - listens on 127.0.0.1 only (nothing outside this computer can reach it)
//   - every request needs the one-time token in the address (stops other web pages poking it)
//   - saved secrets are never sent back to the page — only "saved ✓ …last4"
//   - closes itself after 30 minutes idle, or when the owner clicks "I'm done"
// Tests are read-only, except the email test (one message to the owner) and the Telegram test
// (one message to the owner's own phone).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { loadEnv } = require('./lib/telegram');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const TEMPLATE = path.join(ROOT, '.env.template');
const TOKEN = crypto.randomBytes(18).toString('hex');
const IDLE_MS = 30 * 60 * 1000;
const has = (rel) => fs.existsSync(path.join(__dirname, rel));
const KIT = !has('check-sales.js'); // the Co-Pilot Ads Kit ships only the ads engine
const GRAPH = () => `https://graph.facebook.com/${(loadEnv().META_GRAPH_VERSION || 'v24.0').replace(/^(?!v)/, 'v')}`;

// ── .env writing ────────────────────────────────────────────────────────────────────────────────
// The .env reader (lib/telegram parseEnvValue) strips ONE pair of outer quotes and does no escape
// processing, so wrapping in "…" round-trips any value — including one containing " or ' (e.g. an
// SMTP password). Inner quotes used to be deleted, silently changing the saved password.
function quoteIfNeeded(v) {
  const s = String(v).replace(/[\r\n]/g, '').trim();
  return /[\s#"']/.test(s) ? `"${s}"` : s;
}
function setEnvValues(updates) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8')
    : fs.existsSync(TEMPLATE) ? fs.readFileSync(TEMPLATE, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (const [key, raw] of Object.entries(updates)) {
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    const line = `${key}=${raw === '' || raw == null ? '' : quoteIfNeeded(raw)}`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
    if (i !== -1) lines[i] = line;
    else if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line); // keep the final newline last
    else lines.push(line);
  }
  const tmp = ENV_PATH + '.tmp';
  fs.writeFileSync(tmp, lines.join(eol));
  fs.renameSync(tmp, ENV_PATH);
}

// ── Cards ──────────────────────────────────────────────────────────────────────────────────────
// fields: [key, label, { secret, placeholder, help }]
const CARDS = [
  { id: 'stripe', title: '💳 Stripe — get paid', essential: true, needs: 'check-sales.js',
    fields: [['STRIPE_SECRET_KEY', 'Restricted key (rk_…) or secret key (sk_…)', { secret: true }],
      ['STRIPE_PRODUCT_IDS', 'Only deliver for these products (optional, prod_… comma-separated)', {}]] },
  { id: 'gmail', title: '✉️ Gmail — deliver your product & read support email', essential: true, needs: 'deliver-product.js',
    fields: [['_GMAIL_ADDRESS', 'Your Gmail address', { placeholder: 'you@gmail.com' }],
      ['_GMAIL_APP_PASSWORD', 'Google app password (16 letters)', { secret: true }],
      ['_FROM_NAME', 'Name buyers see (optional)', { placeholder: 'Your Business' }]] },
  { id: 'smtp', title: '✉️ Other email provider (instead of Gmail)', needs: 'deliver-product.js',
    fields: [['EMAIL_HOST', 'SMTP server', { placeholder: 'smtp.yourprovider.com' }], ['EMAIL_PORT', 'Port', { placeholder: '465 or 587' }],
      ['EMAIL_USER', 'Username', {}], ['EMAIL_PASS', 'Password / app password', { secret: true }], ['EMAIL_FROM', 'From address', {}]] },
  { id: 'product', title: '📦 The product buyers receive', essential: true, needs: 'deliver-product.js',
    fields: [['PRODUCT_DOWNLOAD_URL', 'Download link (optional — best for big files)', { placeholder: 'https://drive.google.com/…' }],
      ['EMAIL_SIGN_OFF', 'Sign the delivery email as (optional)', {}]] },
  { id: 'telegram', title: '📱 Phone alerts (Telegram)', needs: 'lib/telegram.js',
    fields: [['TELEGRAM_BOT_TOKEN', 'Bot token from BotFather', { secret: true }], ['TELEGRAM_CHAT_ID', 'Chat ID (click "Find my chat ID")', {}]] },
  { id: 'anthropic', title: '✍️ AI writing key (weekly content writes itself)', needs: 'auto-content.js',
    fields: [['ANTHROPIC_API_KEY', 'Anthropic API key (sk-ant-…)', { secret: true }]] },
  { id: 'facebook', title: '📣 Facebook & Instagram posting (optional)', needs: 'social-post.js',
    fields: [['META_PAGE_ID', 'Facebook Page ID', {}], ['META_PAGE_TOKEN', 'Page access token (long-lived)', { secret: true }],
      ['IG_USER_ID', 'Instagram business account ID (or click "Find my Instagram account")', {}], ['IMGBB_API_KEY', 'imgbb key (for Instagram images)', { secret: true }]] },
  { id: 'metaads', title: '🎯 Meta ads', needs: 'meta-ads.js',
    fields: [['META_AD_ACCOUNT_ID', 'Ad account ID (act_…)', {}], ['META_ADS_TOKEN', 'System User token (ads_management + ads_read)', { secret: true }],
      ['META_PAGE_ID', 'Facebook Page ID', {}], ['IG_USER_ID', 'Instagram business account ID (optional — or click "Find my Instagram account")', {}],
      ['META_PIXEL_ID', 'Pixel ID', {}],
      ['META_CUSTOM_CONVERSION_ID', 'Custom Conversion ID (optional)', {}], ['ADS_COUNTRIES', 'Countries (optional, e.g. US,CA)', {}],
      ['ADS_TARGET_COST_PER_RESULT', "Most you'd pay per lead/result (optional, e.g. 12) — not your product price", { placeholder: "leave blank to use the default, 12 (in your ad account's currency)" }]] },
  { id: 'ghl', title: '🗂️ GoHighLevel CRM (optional)', needs: 'lib/ghl.js',
    fields: [['GHL_TOKEN', 'Private Integration token', { secret: true }], ['GHL_LOCATION_ID', 'Location ID', {}]] },
].filter((c) => has(c.needs));

const SECRET_KEYS = new Set(CARDS.flatMap((c) => c.fields.filter(([, , o]) => o.secret).map(([k]) => k)).concat(['EMAIL_PASS', 'GMAIL_APP_PASSWORD']));

function cardState(card, env) {
  const values = {};
  // A Gmail save fills the shared EMAIL_* keys too (host, user, password). That is Gmail's setup,
  // not an "other provider" one — so the SMTP card stays "not set up" rather than showing Gmail's
  // saved password as its own.
  const gmailOwned = card.id === 'smtp' && (String(env.EMAIL_PROVIDER || '').toLowerCase() === 'gmail' || /smtp\.gmail\.com/i.test(String(env.EMAIL_HOST || '')));
  if (gmailOwned) { for (const [key] of card.fields) values[key] = { set: false }; return values; }
  for (const [key, , opts] of card.fields) {
    let k = key;
    if (key === '_GMAIL_ADDRESS') k = 'GMAIL_USER';
    if (key === '_GMAIL_APP_PASSWORD') k = 'GMAIL_APP_PASSWORD';
    if (key === '_FROM_NAME') {
      // Stored inside EMAIL_FROM as `Name <address>`; show the name back so the card reads as saved.
      const m = String(env.EMAIL_FROM || '').match(/^\s*"?(.*?)"?\s*<[^>]+>\s*$/);
      values[key] = m && m[1] ? { set: true, value: m[1] } : { set: false };
      continue;
    }
    const v = env[k];
    values[key] = v ? (opts.secret || SECRET_KEYS.has(k) ? { set: true, hint: `saved ✓ …${String(v).slice(-4)}` } : { set: true, value: v }) : { set: false };
  }
  return values;
}

// ── Tests (each returns { ok, message }) ─────────────────────────────────────────────────────────
async function getJson(url, headers = {}) {
  try {
    const r = await fetch(url, { headers });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, json: j };
  } catch (e) { return { status: 0, json: { error: { message: e.message } } }; }
}

// Meta answers "(#100)…", "…does not exist" or "Unsupported get request" when the ID itself is wrong
// (a wrong Page ID, or a personal-profile id pasted where the Instagram business id goes).
function badMetaId(r, kind) {
  const m = String((r.json && r.json.error && r.json.error.message) || '');
  if (!/\(#100\)|does not exist|Unsupported get request/i.test(m)) return null;
  return kind === 'ig'
    ? 'That Instagram ID doesn\'t look right — use the "Find my Instagram account" button on the connect page.'
    : 'That ID doesn\'t look right — copy the Page ID from your Facebook Page → About → Page transparency.';
}

const TESTS = {
  async stripe(env) {
    if (!env.STRIPE_SECRET_KEY) return { ok: false, message: 'Paste your Stripe key first.' };
    const r = await getJson('https://api.stripe.com/v1/checkout/sessions?limit=1', { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` });
    const test = /^(sk|rk)_test/.test(env.STRIPE_SECRET_KEY);
    if (r.status === 200) return { ok: true, message: `Connected ✅ ${test ? '— TEST mode (practice payments). Switch to a live key when you open for business.' : '— LIVE mode (real payments).'}` };
    if (r.status === 401) return { ok: false, message: 'Stripe rejected that key. Copy the whole key again (it starts with sk_ or rk_).' };
    if (r.status === 403) return { ok: false, message: 'The key works but can\'t read Checkout Sessions. Edit the restricted key in Stripe and give it Read access to Checkout Sessions, Charges, Products and Prices.' };
    return { ok: false, message: `Couldn't reach Stripe (status ${r.status}). Check your internet and try again.` };
  },
  async email(env) {
    const { sendEmail } = require('./lib/email');
    // The owner's own address: Gmail, else the From address (an SMTP username is often not an email).
    const fromAddr = (String(env.EMAIL_FROM || '').match(/[^\s<>"]+@[^\s<>"]+/) || [])[0];
    const to = env.GMAIL_USER || fromAddr || env.EMAIL_USER;
    if (!to) return { ok: false, message: 'Fill in the email card first.' };
    const r = await sendEmail({ to, subject: 'Your AI Freedom Machine can send email ✅', text: 'This is a test from your connect page. If you can read this, product delivery emails will reach your buyers.' }, env);
    if (r.ok) return { ok: true, message: `Test email sent to ${to} ✅ — check your inbox (and spam, the first time).` };
    if (/nodemailer/i.test(r.reason || '')) return { ok: false, message: 'The email engine isn\'t installed yet — ask your assistant to run the one-time install.' };
    return { ok: false, message: `Not sent. ${r.message || r.reason || ''}` };
  },
  async gmail(env) { return TESTS.email(env); },
  async smtp(env) { return TESTS.email(env); },
  async product(env) {
    if (env.PRODUCT_DOWNLOAD_URL) {
      try {
        const r = await fetch(env.PRODUCT_DOWNLOAD_URL, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30000) });
        // A private Google Drive / Docs link doesn't fail — it answers 200 with a Google sign-in page,
        // so "it opens" was a false green: every buyer would hit a login wall. The redirect gives it away.
        if (/accounts\.google\.com|\/signin|ServiceLogin/i.test(String(r.url || ''))) {
          return { ok: false, message: 'That link opens a Google sign-in page, so buyers couldn\'t download it. In Google Drive: right-click the file → Share → change "Restricted" to "Anyone with the link" → Copy link, then paste it here again.' };
        }
        return r.ok ? { ok: true, message: 'The download link opens ✅ Buyers will get this link.' }
          : { ok: false, message: `That link returned an error (${r.status}). Make sure sharing is set to "anyone with the link".` };
      } catch (e) { return { ok: false, message: `Couldn't open that link: ${e.message}` }; }
    }
    const { productFileStatus } = require('./lib/config'); // the same rule delivery uses
    const st = productFileStatus();
    const f = st.file;
    if (!f) return { ok: false, message: st.problem === 'none' ? 'No product yet: add a download link above, or ask your Product Builder to save the PDF into the Product folder.' : st.message };
    const mb = fs.statSync(f).size / 1048576;
    return mb > 18 ? { ok: false, message: `Found ${path.basename(f)} but it's ${mb.toFixed(1)} MB — too big to email. Put it on Google Drive and paste the link above.` }
      : { ok: true, message: `Found ${path.basename(f)} (${mb.toFixed(1)} MB) ✅ It will be attached to every delivery email.` };
  },
  async telegram(env) {
    const { sendTelegram } = require('./lib/telegram');
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, message: 'Add the bot token, then click "Find my chat ID".' };
    // The Ads Kit has no sale watcher, so it must not promise sale alerts — its messages are the
    // ads results the owner asks for.
    const ok = await sendTelegram(`🎉 You're connected! This is your AI Freedom Machine. ${KIT ? 'You\'ll get your ads results here whenever you run the ads check.' : 'You\'ll get a message here on every sale.'}`, env);
    return ok ? { ok: true, message: 'Sent ✅ — check your phone.' } : { ok: false, message: 'Not sent. Did you send your bot a message ("hi") first? Then click "Find my chat ID" again.' };
  },
  async anthropic(env) {
    if (!env.ANTHROPIC_API_KEY) return { ok: false, message: 'Paste your Anthropic key first.' };
    const r = await getJson('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });
    return r.status === 200 ? { ok: true, message: 'Key works ✅ Weekly content can now write itself.' }
      : { ok: false, message: r.status === 401 ? 'Anthropic rejected that key — copy it again from console.anthropic.com.' : `Couldn't verify (status ${r.status}). Check the account has billing set up.` };
  },
  async facebook(env) {
    if (!env.META_PAGE_ID || !env.META_PAGE_TOKEN) return { ok: false, message: 'Add your Page ID and Page token first.' };
    const r = await getJson(`${GRAPH()}/${env.META_PAGE_ID}?fields=name&access_token=${encodeURIComponent(env.META_PAGE_TOKEN)}`);
    if (r.status !== 200) return { ok: false, message: badMetaId(r, 'page') || `Facebook said: ${(r.json.error && r.json.error.message) || r.status}. The Page token may have expired — ask your assistant for a long-lived Page token.` };
    let msg = `Connected to the "${r.json.name}" Page ✅ Posting stays in preview until you choose to go live.`;
    if (env.IG_USER_ID && !env.IMGBB_API_KEY) msg += ' (Add an imgbb key so Instagram image posts can go out.)';
    return { ok: true, message: msg };
  },
  async metaads(env) {
    const tok = env.META_ADS_TOKEN || env.META_PAGE_TOKEN;
    if (!env.META_AD_ACCOUNT_ID || !tok) return { ok: false, message: 'Add the ad account ID and token first.' };
    const acct = env.META_AD_ACCOUNT_ID.startsWith('act_') ? env.META_AD_ACCOUNT_ID : `act_${env.META_AD_ACCOUNT_ID.replace(/\D/g, '')}`;
    const r = await getJson(`${GRAPH()}/${acct}?fields=name,currency,account_status&access_token=${encodeURIComponent(tok)}`);
    if (r.status !== 200) return { ok: false, message: `Meta said: ${(r.json.error && r.json.error.message) || r.status}. Check the System User has access to this ad account.` };
    const active = r.json.account_status === 1;
    let msg = `${r.json.name} · ${r.json.currency}`;
    if (!active) return { ok: false, message: `${msg} — this ad account is not active; fix it in Ads Manager first.` };
    // A wrong Page/Instagram ID passes the account test and only fails days later when ads are
    // created, so both IDs are read back here and named.
    if (env.META_PAGE_ID) {
      const pg = await getJson(`${GRAPH()}/${env.META_PAGE_ID}?fields=name&access_token=${encodeURIComponent(tok)}`);
      if (pg.status !== 200) return { ok: false, message: `${msg} — but the Facebook Page ID was rejected. ${badMetaId(pg, 'page') || `Meta said: ${(pg.json.error && pg.json.error.message) || pg.status}. Check the System User has access to this Page.`}` };
      msg += ` · Page "${pg.json.name}"`;
    }
    if (env.IG_USER_ID) {
      const ig = await getJson(`${GRAPH()}/${env.IG_USER_ID}?fields=username&access_token=${encodeURIComponent(tok)}`);
      if (ig.status !== 200) return { ok: false, message: `${msg} — but the Instagram account ID was rejected. ${badMetaId(ig, 'ig') || `Meta said: ${(ig.json.error && ig.json.error.message) || ig.status}.`}` };
      msg += ` · @${ig.json.username || env.IG_USER_ID}`;
    }
    return { ok: true, message: `${msg} ✅ Connected. Everything your assistant creates stays PAUSED until you switch it on.` };
  },
  async ghl(env) {
    const ghl = require('./lib/ghl');
    const t = await ghl.testConnection(env);
    return t.ok ? { ok: true, message: `Connected ✅ (${t.contactCount} contacts). New buyers will be added and tagged.` } : { ok: false, message: `Not connected: ${t.reason}` };
  },
};

// Helpers the cards offer as buttons.
const HELPERS = {
  async 'telegram-chat-id'(env) {
    if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, message: 'Paste and save the bot token first.' };
    const r = await getJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
    if (r.status !== 200) return { ok: false, message: 'Telegram rejected that token — copy it again from BotFather.' };
    const msgs = (r.json.result || []).map((u) => u.message || u.edited_message).filter(Boolean);
    const last = msgs[msgs.length - 1];
    if (!last) return { ok: false, message: 'No messages yet. Open your bot in Telegram, tap Start, send "hi", then click this again.' };
    setEnvValues({ TELEGRAM_CHAT_ID: String(last.chat.id) });
    return { ok: true, message: `Found it ✅ (chat ${last.chat.id}, ${last.chat.first_name || 'you'}). Saved — now click Save & test.` };
  },
  async 'find-instagram'(env) {
    // The Ads Kit has no Page token — the ads System User token can read the Page's linked account.
    const tok = env.META_PAGE_TOKEN || env.META_ADS_TOKEN;
    if (!env.META_PAGE_ID || !tok) return { ok: false, message: 'Save the Page ID and a token (Page token, or the ads token) first.' };
    const r = await getJson(`${GRAPH()}/${env.META_PAGE_ID}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(tok)}`);
    if (r.status !== 200) return { ok: false, message: `Meta said: ${(r.json.error && r.json.error.message) || r.status}. Check the Page ID, and that the token has access to this Page.` };
    const ig = r.json && r.json.instagram_business_account;
    if (!ig) return { ok: false, message: 'No Instagram business account is linked to this Page. In Instagram: Settings → Account type → switch to Business, then link it to the Page.' };
    setEnvValues({ IG_USER_ID: ig.id });
    return { ok: true, message: `Found @${ig.username || ig.id} ✅ Saved.` };
  },
};

// ── Save: map card inputs to .env keys ─────────────────────────────────────────────────────────
function saveCard(cardId, input) {
  const card = CARDS.find((c) => c.id === cardId);
  if (!card) throw new Error('unknown card');
  const clean = (v) => String(v == null ? '' : v).replace(/[\r\n]/g, '').trim();
  const updates = {};
  if (cardId === 'gmail') {
    const addr = clean(input._GMAIL_ADDRESS);
    const pw = clean(input._GMAIL_APP_PASSWORD).replace(/\s+/g, '');
    const name = clean(input._FROM_NAME);
    if (addr) Object.assign(updates, { GMAIL_USER: addr, EMAIL_USER: addr, EMAIL_HOST: 'smtp.gmail.com', EMAIL_PORT: '465', EMAIL_PROVIDER: 'gmail' });
    if (addr || name) { const a = addr || loadEnv().GMAIL_USER || ''; if (a) updates.EMAIL_FROM = name ? `${name.replace(/[<>"]/g, '')} <${a}>` : a; }
    if (pw) Object.assign(updates, { GMAIL_APP_PASSWORD: pw, EMAIL_PASS: pw });
  } else {
    for (const [key] of card.fields) {
      if (!(key in input)) continue;
      let v = clean(input[key]);
      if (!v && SECRET_KEYS.has(key)) continue; // blank secret box = keep the saved one
      if (key === 'META_AD_ACCOUNT_ID' && v && !v.startsWith('act_')) v = `act_${v.replace(/\D/g, '')}`;
      // "$15" -> "15" (Number("$15") is NaN). A decimal comma is a decimal point ("12,50" -> "12.50",
      // not 1250); a comma before exactly three digits is a thousands separator ("1,200" -> "1200").
      if (key === 'ADS_TARGET_COST_PER_RESULT') v = v.replace(/,(?=\d{3}(?!\d))/g, '').replace(/,/g, '.').replace(/[^\d.]/g, '').replace(/\.(?=.*\.)/g, '');
      if (key === 'ADS_COUNTRIES') v = v.toUpperCase().replace(/[^A-Z,]/g, '');
      updates[key] = v;
    }
  }
  if (Object.keys(updates).length) setEnvValues(updates);
  return Object.keys(updates).length;
}

// ── Page ─────────────────────────────────────────────────────────────────────────────────────────
function page() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your accounts</title><style>
:root{--ink:#16202b;--muted:#5b6b7a;--line:#e3e8ee;--bg:#f6f8fa;--card:#fff;--ok:#0f9d76;--bad:#c2410c;--brand:#00a88f}
@media (prefers-color-scheme:dark){:root{--ink:#e8eef4;--muted:#9fb0c0;--line:#2a3542;--bg:#11161c;--card:#18202a}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:760px;margin:0 auto;padding:28px 16px 80px}h1{font-size:26px;margin:0 0 6px}p.lead{color:var(--muted);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:0 0 14px}
.card h2{font-size:18px;margin:0 0 4px;display:flex;justify-content:space-between;gap:8px;align-items:center}
.pill{font-size:12px;border-radius:99px;padding:2px 10px;background:var(--line);color:var(--muted);white-space:nowrap}.pill.ok{background:rgba(15,157,118,.15);color:var(--ok)}
label{display:block;font-size:14px;color:var(--muted);margin:12px 0 4px}input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:transparent;color:var(--ink)}
.hint{font-size:13px;color:var(--ok);margin-top:3px}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
button{font:inherit;border:0;border-radius:10px;padding:9px 16px;cursor:pointer;background:var(--brand);color:#fff}button.sec{background:var(--line);color:var(--ink)}
.msg{margin-top:12px;font-size:15px;padding:10px 12px;border-radius:10px;display:none}.msg.ok{display:block;background:rgba(15,157,118,.12);color:var(--ok)}.msg.bad{display:block;background:rgba(194,65,12,.1);color:var(--bad)}
.ess{font-size:12px;color:var(--brand);font-weight:600}footer{text-align:center;margin-top:24px}
</style></head><body><main>
<h1>Connect your accounts</h1>
<p class="lead">This page runs on your computer only. Paste each item your assistant asks for, click <b>Save &amp; test</b>, and look for the green check. Your keys are saved in a private file on this computer and never shown here again.</p>
<div id="cards"></div>
<footer><button class="sec" onclick="done()">I'm done — close this page</button></footer>
</main><script>
const T=${JSON.stringify(TOKEN)};
const api=(p,b)=>fetch(p+'?t='+T,{method:b?'POST':'GET',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){const {cards}=await api('/api/state');const el=document.getElementById('cards');el.innerHTML='';
for(const c of cards){const d=document.createElement('section');d.className='card';d.id='c-'+c.id;
const anySet=Object.values(c.values).some(v=>v.set);
d.innerHTML='<h2><span>'+esc(c.title)+'</span><span class="pill '+(anySet?'ok':'')+'">'+(anySet?'saved':'not set up')+'</span></h2>'+(c.essential?'<div class="ess">Essential</div>':'')+
c.fields.map(f=>{const v=c.values[f.key]||{};return '<label for="'+c.id+f.key+'">'+esc(f.label)+'</label><input id="'+c.id+f.key+'" data-key="'+f.key+'" type="'+(f.secret?'password':'text')+'" autocomplete="off" placeholder="'+esc(v.set&&f.secret?'(saved — leave blank to keep)':(f.placeholder||''))+'" value="'+esc(v.value||'')+'">'+(v.hint?'<div class="hint">'+esc(v.hint)+'</div>':'')}).join('')+
'<div class="row"><button onclick="save(\\''+c.id+'\\')">Save &amp; test</button>'+(c.helpers||[]).map(h=>'<button class="sec" onclick="help(\\''+c.id+'\\',\\''+h.id+'\\')">'+esc(h.label)+'</button>').join('')+'</div><div class="msg"></div>';
el.appendChild(d);}}
function show(id,r){const m=document.querySelector('#c-'+id+' .msg');m.className='msg '+(r.ok?'ok':'bad');m.textContent=r.message||(r.ok?'Done':'Something went wrong');}
async function save(id){const input={};document.querySelectorAll('#c-'+id+' input').forEach(i=>input[i.dataset.key]=i.value);
show(id,{ok:true,message:'Saving and testing…'});const r=await api('/api/save',{card:id,input});await load();show(id,r);}
async function help(id,h){show(id,{ok:true,message:'Checking…'});const r=await api('/api/helper',{helper:h});await load();show(id,r);}
async function done(){await api('/api/done',{});document.body.innerHTML='<main><h1>All saved ✅</h1><p class="lead">You can close this tab and go back to your assistant.</p></main>';}
load();
</script></body></html>`;
}

const HELPER_BUTTONS = { telegram: [{ id: 'telegram-chat-id', label: 'Find my chat ID' }], facebook: [{ id: 'find-instagram', label: 'Find my Instagram account' }],
  metaads: [{ id: 'find-instagram', label: 'Find my Instagram account' }] };
const TEST_FOR = { stripe: 'stripe', gmail: 'gmail', smtp: 'smtp', product: 'product', telegram: 'telegram', anthropic: 'anthropic', facebook: 'facebook', metaads: 'metaads', ghl: 'ghl' };

// ── Server ─────────────────────────────────────────────────────────────────────────────────────
let idleTimer;
function bumpIdle(server) { clearTimeout(idleTimer); idleTimer = setTimeout(() => { console.log('Connect page closed (idle).'); server.close(); process.exit(0); }, IDLE_MS); }

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
  });
}

function start(port, tries = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.searchParams.get('t') !== TOKEN) return send(403, 'This page needs the link your assistant gave you.', 'text/plain');
    bumpIdle(server);
    try {
      if (url.pathname === '/' && req.method === 'GET') return send(200, page(), 'text/html; charset=utf-8');
      if (url.pathname === '/api/state') {
        const env = loadEnv();
        return send(200, { cards: CARDS.map((c) => ({ id: c.id, title: c.title, essential: !!c.essential, helpers: HELPER_BUTTONS[c.id] || [],
          fields: c.fields.map(([key, label, o]) => ({ key, label, secret: !!o.secret, placeholder: o.placeholder || '' })), values: cardState(c, env) })) });
      }
      if (req.method !== 'POST') return send(405, { ok: false });
      const body = await readBody(req);
      if (url.pathname === '/api/save') {
        const n = saveCard(body.card, body.input || {});
        const test = TESTS[TEST_FOR[body.card]];
        if (!test) return send(200, { ok: true, message: n ? 'Saved ✅' : 'Nothing to save.' });
        return send(200, await test(loadEnv()));
      }
      if (url.pathname === '/api/helper') {
        const h = HELPERS[body.helper];
        return send(200, h ? await h(loadEnv()) : { ok: false, message: 'Unknown helper.' });
      }
      if (url.pathname === '/api/done') { send(200, { ok: true }); console.log('Connect page closed by the owner. ✅'); setTimeout(() => process.exit(0), 300); return; }
      return send(404, { ok: false });
    } catch (e) { return send(200, { ok: false, message: `Something went wrong: ${e.message}` }); }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 10) return start(port + 1, tries + 1);
    console.log(`Couldn't open the connect page: ${e.message}`); process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const link = `http://localhost:${port}/?t=${TOKEN}`;
    console.log(`Connect page is open: ${link}`);
    console.log(`(${KIT ? 'Ads Kit' : 'Auto-Pilot'} · ${CARDS.length} cards · closes after 30 minutes idle)`);
    bumpIdle(server);
    if (!process.argv.includes('--no-open')) {
      const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
      execFile(cmd, args, () => {});
    }
  });
}

module.exports = { setEnvValues, saveCard, CARDS };
if (require.main === module) start(4848);
