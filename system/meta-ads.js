// Meta ads runtime — Auto-Pilot (system/) and the Co-Pilot Ads Kit share this exact file.
//
//   node system/meta-ads.js check                 read-only: account, currency, pixel events
//   node system/meta-ads.js setup                 create the campaign + ad set, PAUSED
//   node system/meta-ads.js upload                turn finished creatives into PAUSED ads
//   node system/meta-ads.js monitor [--days 7]    read-only daily analysis -> Telegram
//                                    [--now]       run right now, even outside working hours
//                                    [--quiet]     print only — no phone message
//
// EVERYTHING IS CREATED PAUSED. This file never enables an ad, never raises a budget, and never
// spends money. The monitor is strictly read-only and only ever *recommends* — because thresholds
// are guesses until there's real data, and an automated killer acting on guessed thresholds will
// confidently turn off a winner that simply hadn't converted yet.
//
// Creatives are picked up from  Content/ads/<campaign>/  with a copy sidecar per creative:
//     my-ad.png / my-ad.jpg   an image ad (4:5, 1080x1350 works everywhere)
//     my-ad.mp4 / my-ad.mov   OR a video ad (9:16 or 4:5; Meta makes the thumbnail)
//     my-ad.txt               REQUIRED — HEADLINE: / DESCRIPTION: / --- / body copy
// Uploaded files move to  Content/ads/<campaign>/_uploaded/  so a re-run can't double-post.

const fs = require('fs');
const path = require('path');
const { loadEnv, sendTelegram } = require('./lib/telegram');
const { guardOrExit } = require('./lib/working-hours');

const env = loadEnv();
const V = (env.META_GRAPH_VERSION || 'v24.0').replace(/^(?!v)/, 'v');
const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'ads-state.json');
const ADS_DIR = path.join(ROOT, 'Content', 'ads');

const TOKEN = env.META_ADS_TOKEN || env.META_PAGE_TOKEN;
const RAW_ACCOUNT = String(env.META_AD_ACCOUNT_ID || '').trim();
const ACCOUNT = RAW_ACCOUNT ? (RAW_ACCOUNT.startsWith('act_') ? RAW_ACCOUNT : `act_${RAW_ACCOUNT.replace(/\D/g, '')}`) : '';
const PAGE_ID = env.META_PAGE_ID;
const PIXEL_ID = env.META_PIXEL_ID;
const IG_ID = env.IG_USER_ID || '';

const IMAGE_RE = /\.(png|jpe?g)$/i;
const VIDEO_RE = /\.(mp4|mov)$/i;

let CURRENCY = 'USD';
const money = (n) => {
  const v = Number(n || 0);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY }).format(v); }
  catch (_) { return `${v.toFixed(2)} ${CURRENCY}`; }
};
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, '')); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const customConversionId = (state) => env.META_CUSTOM_CONVERSION_ID || state.customConversionId || null;
const argVal = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);

function needCreds() {
  const missing = [];
  if (!TOKEN) missing.push('META_ADS_TOKEN');
  if (!ACCOUNT) missing.push('META_AD_ACCOUNT_ID');
  if (!PAGE_ID) missing.push('META_PAGE_ID');
  if (missing.length) {
    console.log(`Meta ads not connected yet — missing ${missing.join(', ')} in .env.`);
    console.log('Ask your assistant to open the connect page and fill in the Meta ads card.');
    process.exit(0);
  }
}

// Plain-English version of the Meta errors buyers actually hit.
// `node` is the object a GET read: a wrong Page/Instagram ID answers "(#100)…", "…does not exist" or
// "Unsupported get request" (that last one also says "missing permissions", so it must be checked first).
function friendly(msg, node = '') {
  const m = String(msg || '');
  if (/access token|session has expired|OAuthException|Error validating/i.test(m)) return `${m}\n→ The Meta token has expired or lacks permission. Ask your assistant to "reconnect my Meta ads token".`;
  if (node && !node.includes('/') && /\(#100\)|does not exist|Unsupported get request/i.test(m)) {
    if (IG_ID && node === IG_ID) return `${m}\n→ That Instagram ID doesn't look right — use the "Find my Instagram account" button on the connect page.`;
    if (node === PAGE_ID) return `${m}\n→ That ID doesn't look right — copy the Page ID from your Facebook Page → About → Page transparency.`;
    return `${m}\n→ That ID doesn't look right — check it on the connect page.`;
  }
  if (/permission|not authorized|\(#200\)|\(#10\)/i.test(m)) return `${m}\n→ The token can't manage this ad account. In Business Settings, give the System User "Manage campaigns" on the ad account and Page.`;
  if (/payment|funding|billing/i.test(m)) return `${m}\n→ The ad account needs a payment method before Meta accepts ads.`;
  return m;
}

async function graph(node, method = 'GET', params = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  body.set('access_token', TOKEN);
  const url = `https://graph.facebook.com/${V}/${node}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = method === 'GET'
        ? await fetch(`${url}?${body}`)
        : await fetch(url, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    } catch (err) {
      // Offline / DNS / reset: fetch throws a bare "fetch failed". Retry, then say it plainly.
      lastErr = `couldn't reach Meta (${(err.cause && err.cause.code) || err.message}) — check the internet connection`;
      if (attempt === 3) break;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (res.ok && !j.error) return j;
    lastErr = (j.error && j.error.message) || `status ${res.status}`;
    // Meta's transient codes (1, 2, 4, 17, 341) and 5xx are worth a short retry; nothing else is.
    const code = j.error && j.error.code;
    const transient = res.status >= 500 || [1, 2, 4, 17, 341].includes(code) || (j.error && j.error.is_transient);
    if (!transient || attempt === 3) break;
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  throw new Error(`Meta ${method} ${node}: ${friendly(lastErr, method === 'GET' ? node : '')}`);
}

async function loadCurrency() {
  try { const a = await graph(ACCOUNT, 'GET', { fields: 'currency' }); if (a.currency) CURRENCY = a.currency; } catch (_) {}
}

// ── check ───────────────────────────────────────────────────────────────────────────────────────
// Read-only preflight. Two things silently ruin ad spend, and both are checked here BEFORE
// anything is created: a currency mismatch (values get booked in the account's currency, making
// every campaign look less profitable than it is) and a pixel that never fires the event you're
// optimizing for (spends fully, learns nothing, delivers junk traffic).
async function check() {
  needCreds();
  const acct = await graph(ACCOUNT, 'GET', { fields: 'name,currency,account_status,timezone_name' });
  console.log(`\nAd account : ${acct.name}`);
  console.log(`Currency   : ${acct.currency}   <- conversion values are recorded in THIS currency`);
  console.log(`Status     : ${acct.account_status === 1 ? 'active' : 'NOT active (code ' + acct.account_status + ') — fix this in Ads Manager first'}`);
  console.log(`Timezone   : ${acct.timezone_name}`);
  console.log(`API version: ${V}`);
  // The Page/Instagram IDs are only used when an ad is created, so a typo would surface days later.
  try { const pg = await graph(PAGE_ID, 'GET', { fields: 'name' }); console.log(`Page       : ${pg.name} (${PAGE_ID})`); }
  catch (e) { console.log(`Page       : ⚠️ the Facebook Page ID was rejected — ${e.message}`); }
  if (IG_ID) {
    try { const ig = await graph(IG_ID, 'GET', { fields: 'username' }); console.log(`Instagram  : @${ig.username || IG_ID} (${IG_ID})`); }
    catch (e) { console.log(`Instagram  : ⚠️ the Instagram account ID was rejected — ${e.message}`); }
  }

  if (!PIXEL_ID) { console.log('\nNo META_PIXEL_ID set — add it so conversions can be tracked.'); return; }
  try {
    const since = new Date(Date.now() - 28 * 864e5).toISOString();
    const s = await graph(`${PIXEL_ID}/stats`, 'GET', { aggregation: 'event', start_time: since });
    const totals = {};
    for (const row of s.data || []) for (const d of row.data || []) totals[d.value] = (totals[d.value] || 0) + Number(d.count || 0);
    const seen = Object.entries(totals);
    console.log(`\nPixel events (last 28 days): ${seen.length ? seen.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`);
    const real = seen.filter(([k]) => k !== 'PageView');
    // Remember what the pixel fires, so `setup` only warns when there is actually nothing to
    // optimize for (instead of telling someone who just ran this to "run check first").
    const st = readState(); st.pixelEvents = Object.keys(totals); st.checkedAt = new Date().toISOString(); writeState(st);
    if (!real.length && !customConversionId(st)) {
      console.log('\n⚠️  The pixel has only ever fired PageView.');
      console.log('    A campaign optimizing for leads or purchases CANNOT learn from this — but it will');
      console.log('    still spend, on whoever is cheapest to reach. Fix it first with a Custom Conversion');
      console.log('    built on your thank-you page URL (Events Manager -> Custom Conversions), then put');
      console.log('    its id in .env as META_CUSTOM_CONVERSION_ID. Ask me and I\'ll walk you through it.');
    }
  } catch (e) { console.log(`\nCould not read pixel stats: ${e.message}`); }
}

// ── setup ───────────────────────────────────────────────────────────────────────────────────────
// Creates ONE durable campaign + ad set, PAUSED. Run this once per objective, never weekly:
// optimization history lives on the ad set, so recreating it every week keeps you permanently in
// the learning phase. Fresh creatives go into this same ad set via `upload`.
async function setup() {
  needCreds();
  const state = readState();
  const key = argVal('--name') || 'leads';
  const budgetArg = Number(argVal('--budget') || 20);
  const destination = argVal('--url');

  if (!destination) { console.log('Need --url <your landing page>. Example:\n  node system/meta-ads.js setup --name leads --budget 20 --url https://yoursite.com/free'); return; }
  if (!/^[a-z0-9-]{1,30}$/i.test(key)) { console.log('--name must be a short word like "leads" or "workshop" (letters, numbers, dashes).'); return; }
  if (state[key] && state[key].adsetId) { console.log(`"${key}" already exists (campaign ${state[key].campaignId}). Nothing to do — new creatives go into that same ad set.`); return; }
  if (!Number.isFinite(budgetArg) || budgetArg < 1) { console.log('--budget must be a daily amount like 20.'); return; }

  const cc = customConversionId(state);
  if (!cc) {
    // Without a custom conversion the ad set optimizes for the pixel's Lead event. That's fine when
    // the pixel really fires one; it's a silent money leak when it only ever fires PageView.
    const realEvents = (state.pixelEvents || []).filter((k) => k !== 'PageView');
    if (!state.checkedAt) {
      console.log('⚠️  No custom conversion set (META_CUSTOM_CONVERSION_ID), and "check" hasn\'t been run yet.');
      console.log('    If your funnel only fires PageView, the ad set will spend without learning.');
      console.log('    Run "check" first. Continuing anyway — but everything stays PAUSED.\n');
    } else if (!realEvents.length) {
      console.log('⚠️  No custom conversion set (META_CUSTOM_CONVERSION_ID), and your pixel has only fired PageView.');
      console.log('    The ad set will spend without learning until a real event or a Custom Conversion exists.');
      console.log('    Continuing anyway — but everything stays PAUSED.\n');
    }
  }
  if (!cc && !PIXEL_ID) { console.log('Need META_PIXEL_ID (or META_CUSTOM_CONVERSION_ID) so Meta knows what a result is.'); return; }

  // Ad-set budgets: newer API versions require the campaign to say explicitly that ad sets don't
  // share budget. Older versions reject the unknown field, so fall back without it.
  const campaignParams = { name: `Ads — ${key}`, objective: 'OUTCOME_LEADS', status: 'PAUSED', special_ad_categories: [] };
  // A campaign left over from a setup whose ad set failed (e.g. a pixel problem) is reused, so a
  // re-run never piles up empty paused campaigns.
  let campaign = state[key] && state[key].campaignId ? { id: state[key].campaignId } : null;
  if (!campaign) {
    try { campaign = await graph(`${ACCOUNT}/campaigns`, 'POST', { ...campaignParams, is_adset_budget_sharing_enabled: false }); }
    catch (e) {
      if (!/budget_sharing/i.test(e.message)) throw e;
      campaign = await graph(`${ACCOUNT}/campaigns`, 'POST', campaignParams);
    }
    state[key] = { campaignId: campaign.id, destination, createdAt: new Date().toISOString() };
    writeState(state);
  }

  const targeting = {
    geo_locations: { countries: (env.ADS_COUNTRIES || 'US,CA,GB,AU').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) },
    age_min: Number(env.ADS_AGE_MIN) || 25,
    age_max: Number(env.ADS_AGE_MAX) || 65,
    // Advantage+ audience expansion OFF. Broad targeting is good; expansion lets Meta wander
    // outside your targeting to find cheaper people, which is the main source of junk leads.
    targeting_automation: { advantage_audience: 0 },
    // Facebook + Instagram only — this excludes Audience Network, where most "clicks" are
    // accidental taps in third-party apps and games.
    publisher_platforms: ['facebook', 'instagram'],
    facebook_positions: ['feed', 'story', 'facebook_reels'],
    instagram_positions: ['stream', 'explore', 'story', 'reels'],
  };
  if (state.excludeAudienceIds && state.excludeAudienceIds.length) {
    // Never pay to advertise a product to someone who already bought it.
    targeting.excluded_custom_audiences = state.excludeAudienceIds.map((id) => ({ id }));
  }

  const adsetParams = (promoted) => ({
    name: `${key} — evergreen`, campaign_id: campaign.id, status: 'PAUSED',
    billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE',
    promoted_object: promoted, daily_budget: Math.round(budgetArg * 100),
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP', targeting,
  });
  let adset;
  if (cc) {
    try { adset = await graph(`${ACCOUNT}/adsets`, 'POST', adsetParams({ custom_conversion_id: cc })); }
    catch (e) {
      if (!PIXEL_ID) throw e;
      adset = await graph(`${ACCOUNT}/adsets`, 'POST', adsetParams({ pixel_id: PIXEL_ID, custom_conversion_id: cc, custom_event_type: 'OTHER' }));
    }
  } else {
    adset = await graph(`${ACCOUNT}/adsets`, 'POST', adsetParams({ pixel_id: PIXEL_ID, custom_event_type: 'LEAD' }));
  }

  await loadCurrency();
  state[key] = { campaignId: campaign.id, adsetId: adset.id, destination, optimizeFor: cc ? 'custom' : 'LEAD', createdAt: new Date().toISOString() };
  writeState(state);
  fs.mkdirSync(path.join(ADS_DIR, key), { recursive: true });
  console.log(`\n✅ Created PAUSED: campaign ${campaign.id}, ad set ${adset.id} at ${money(budgetArg)}/day.`);
  console.log(`   Drop finished ads into Content/ads/${key}/ and run "upload".`);
  console.log('   Nothing will spend until you switch it on yourself:');
  console.log(`   https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${ACCOUNT.replace('act_', '')}`);
}

// ── upload ──────────────────────────────────────────────────────────────────────────────────────
function readCopy(dir, base) {
  for (const ext of ['.txt', '.md']) {
    const p = path.join(dir, base + ext);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8').replace(/\r/g, '');
    const parts = raw.split(/^---\s*$/m);
    const head = parts[0];
    // [ \t]* not \s*: with \s* an empty "DESCRIPTION:" swallowed the newline and grabbed the next
    // line ("---" or the headline) as its value.
    const grab = (k) => { const m = head.match(new RegExp('^' + k + ':[ \\t]*(.*)$', 'im')); return m ? m[1].trim() : ''; };
    const body = parts.slice(1).join('---').trim() || head.replace(/^(HEADLINE|DESCRIPTION):.*$/gim, '').trim();
    return { headline: grab('HEADLINE'), description: grab('DESCRIPTION'), message: body };
  }
  return null;
}

async function uploadImage(file) {
  const j = await graph(`${ACCOUNT}/adimages`, 'POST', { bytes: fs.readFileSync(file).toString('base64') });
  const first = Object.values(j.images || {})[0];
  if (!first || !first.hash) throw new Error('image upload returned no hash');
  return first.hash;
}

// Video: multipart upload to the ad account, wait until Meta has processed it, then borrow
// Meta's own auto-generated thumbnail (a video creative must have one).
async function uploadVideo(file) {
  const form = new FormData();
  form.set('access_token', TOKEN);
  form.set('name', path.basename(file));
  form.set('source', new Blob([fs.readFileSync(file)]), path.basename(file));
  const res = await fetch(`https://graph-video.facebook.com/${V}/${ACCOUNT}/advideos`, { method: 'POST', body: form });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error || !j.id) throw new Error(friendly((j.error && j.error.message) || `video upload failed (status ${res.status})`));
  for (let i = 0; i < 40; i++) {
    const v = await graph(j.id, 'GET', { fields: 'status' });
    const st = v.status && v.status.video_status;
    if (st === 'ready') break;
    if (st === 'error') throw new Error('Meta could not process this video — check it plays, and is under 4GB.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  const th = await graph(`${j.id}/thumbnails`, 'GET', {});
  const pick = (th.data || []).find((t) => t.is_preferred) || (th.data || [])[0];
  if (!pick || !pick.uri) throw new Error('video uploaded, but Meta has no thumbnail for it yet — run upload again in a few minutes');
  return { videoId: j.id, thumb: pick.uri };
}

async function upload() {
  needCreds();
  const state = readState();
  const keys = Object.keys(state).filter((k) => state[k] && state[k].adsetId);
  if (!keys.length) { console.log('No campaign yet — run "setup" first.'); return; }

  let made = 0;
  const problems = [];
  // Ads the weekly writer rendered land in Content/ads/ready/. With a single campaign they go
  // straight into it; with several, the seller picks by moving them into Content/ads/<campaign>/.
  const readyDir = path.join(ADS_DIR, 'ready');
  const jobs = [];
  for (const key of keys) {
    const dirs = [path.join(ADS_DIR, key)];
    if (keys.length === 1 && fs.existsSync(readyDir)) dirs.push(readyDir);
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); continue; }
      // "-9x16" / "-story" variants are placement extras for a main file, never an ad of their own.
      for (const f of fs.readdirSync(dir)) {
        if ((IMAGE_RE.test(f) || VIDEO_RE.test(f)) && !/-(9x16|vertical|story)\.[^.]+$/i.test(f)) jobs.push({ key, dir, file: f });
      }
    }
  }
  if (keys.length > 1 && fs.existsSync(readyDir) && fs.readdirSync(readyDir).some((f) => IMAGE_RE.test(f) || VIDEO_RE.test(f))) {
    console.log(`Ads are waiting in Content/ads/ready/ — you have ${keys.length} campaigns (${keys.join(', ')}), so move each one into the campaign folder it belongs to.`);
  }
  if (!jobs.length) console.log('Nothing waiting to upload.');

  for (const { key, dir, file } of jobs) {
    {
      const base = file.replace(/\.[^.]+$/, '');
      const copy = readCopy(dir, base);
      if (!copy || !copy.message) { problems.push(`${file}: no ${base}.txt copy file`); console.log(`  ! ${file}: no ${base}.txt copy file — skipped`); continue; }
      try {
        const link = state[key].destination;
        const cta = { type: 'LEARN_MORE', value: { link } };
        let spec;
        if (VIDEO_RE.test(file)) {
          const v = await uploadVideo(path.join(dir, file));
          spec = { page_id: PAGE_ID, ...(IG_ID ? { instagram_user_id: IG_ID } : {}),
            video_data: { video_id: v.videoId, image_url: v.thumb, message: copy.message, title: copy.headline, link_description: copy.description, call_to_action: cta } };
        } else {
          const hash = await uploadImage(path.join(dir, file));
          spec = { page_id: PAGE_ID, ...(IG_ID ? { instagram_user_id: IG_ID } : {}),
            link_data: { image_hash: hash, link, message: copy.message, name: copy.headline, description: copy.description, call_to_action: cta } };
        }
        const creative = await graph(`${ACCOUNT}/adcreatives`, 'POST', {
          name: base.slice(0, 100),
          url_tags: 'utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_id={{campaign.id}}&ad_id={{ad.id}}&adset_id={{adset.id}}',
          object_story_spec: spec,
        });
        const ad = await graph(`${ACCOUNT}/ads`, 'POST', {
          name: base.slice(0, 100), adset_id: state[key].adsetId, creative: { creative_id: creative.id }, status: 'PAUSED',
        });
        console.log(`  ✓ PAUSED ad created: ${base} (${ad.id})`);
        made++;
        // Move ONLY this ad's own files (exact base name + its placement variants) — never a
        // neighbor like "hook-2" when uploading "hook".
        const done = path.join(dir, '_uploaded');
        fs.mkdirSync(done, { recursive: true });
        const mine = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-(9x16|vertical|story))?\\.[^.]+$`, 'i');
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (mine.test(f) && fs.statSync(full).isFile()) fs.renameSync(full, path.join(done, f));
        }
      } catch (e) { problems.push(`${file}: ${e.message.split('\n')[0]}`); console.log(`  ! ${file}: ${e.message}`); }
    }
  }
  if (made) {
    console.log(`\n✅ ${made} new ad(s), all PAUSED. Review and enable the ones you want.`);
    await sendTelegram(`${made} new Meta ad(s) uploaded and PAUSED. Review them in Ads Manager when you get a minute — nothing is spending yet.${problems.length ? `\n\n⚠️ ${problems.length} couldn't upload:\n${problems.slice(0, 5).join('\n')}` : ''}`, env);
  } else if (problems.length) {
    await sendTelegram(`⚠️ Meta ad upload: nothing uploaded.\n${problems.slice(0, 5).join('\n')}`, env);
  }
}

// ── monitor ─────────────────────────────────────────────────────────────────────────────────────
// READ-ONLY. Recommends; never acts. Refuses to judge anything on thin data, because killing a
// good ad after a few dollars of spend is the most common way people waste money on ads.
const LEAD_TYPES = ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped'];
const REG_TYPES = ['complete_registration', 'offsite_conversion.fb_pixel_complete_registration'];
const PURCH_TYPES = ['purchase', 'offsite_conversion.fb_pixel_purchase'];
const PRESETS = [3, 7, 14, 28, 30, 90];

function actionCount(row, types) {
  let best = 0;
  for (const a of row.actions || []) if (types.includes(a.action_type)) best = Math.max(best, Number(a.value || 0));
  return best; // max, not sum — Meta reports the same conversion under several aliases
}

async function monitor() {
  needCreds();
  // Scheduled runs respect working hours; "--now" is an on-request check (the owner asked).
  if (!process.argv.includes('--now')) guardOrExit('ads-monitor');
  await loadCurrency();
  const state = readState();
  const cc = customConversionId(state);
  const askDays = Number(argVal('--days') || 7);
  const days = PRESETS.reduce((a, b) => (Math.abs(b - askDays) < Math.abs(a - askDays) ? b : a), 7);
  const MIN_SPEND = Number(env.ADS_MIN_SPEND_BEFORE_JUDGING) || 20;
  const KILL_NO_RESULT = Number(env.ADS_KILL_SPEND_NO_RESULT) || 30;
  const TARGET = Number(env.ADS_TARGET_COST_PER_RESULT) || 12;
  const MIN_AGE_DAYS = 3;
  const FATIGUE = 2.5;

  const r = await graph(`${ACCOUNT}/insights`, 'GET', {
    level: 'ad', date_preset: `last_${days}d`, limit: 200,
    fields: 'ad_id,ad_name,adset_id,campaign_id,campaign_name,spend,impressions,inline_link_clicks,inline_link_click_ctr,frequency,actions',
  });
  const rows = r.data || [];
  if (!rows.length) {
    console.log(`No ad delivery in the last ${days} days — campaigns are paused or haven't spent.`);
    return;
  }

  // Ad age: never judge an ad in its first few days — delivery is still settling.
  const ageDays = {};
  try {
    const ads = await graph(`${ACCOUNT}/ads`, 'GET', { fields: 'id,created_time', limit: 500 });
    for (const a of ads.data || []) ageDays[a.id] = (Date.now() - new Date(a.created_time).getTime()) / 864e5;
  } catch (_) { /* age unknown — spend floor still protects */ }

  // A result is whatever this account optimizes for: the custom conversion if one is set (it
  // reports as offsite_conversion.custom.<id>, not "purchase"), else standard lead/signup/purchase.
  const resultOf = (row) => {
    if (cc) {
      const custom = actionCount(row, [`offsite_conversion.custom.${cc}`]);
      if (custom) return custom;
    }
    return actionCount(row, LEAD_TYPES) || actionCount(row, REG_TYPES) || actionCount(row, PURCH_TYPES);
  };

  // Only ads in the campaigns / ad sets this engine created (recorded in ads-state.json by "setup")
  // get a SCALE / SWITCH OFF style verdict. A campaign the owner built by hand may count something
  // else as its result (a sales campaign, where a purchase costs far more than a lead), so the lead
  // thresholds here would give it wrong advice. Those rows are still listed, just not judged.
  const ours = { campaigns: new Set(), adsets: new Set() };
  for (const v of Object.values(state)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (v.campaignId) ours.campaigns.add(String(v.campaignId));
    if (v.adsetId) ours.adsets.add(String(v.adsetId));
  }
  const isOurs = (row) => ours.adsets.has(String(row.adset_id)) || ours.campaigns.has(String(row.campaign_id));
  const NOT_JUDGED = 'not judged — a campaign you built yourself; judge it by its own goal (cost per lead or per sale)';
  let notJudged = 0;

  const lines = [`Meta ads — last ${days} days`];
  const recs = [];
  let totalSpend = 0, totalResults = 0; // the judged (engine) ads only
  let allSpend = 0, allResults = 0; // every ad — the dashboard reads the first Total line, so it must be the whole account

  for (const row of rows.sort((a, b) => Number(b.spend) - Number(a.spend))) {
    const spend = Number(row.spend || 0);
    const results = resultOf(row);
    const cost = results ? spend / results : null;
    const freq = Number(row.frequency || 0);
    const linkCtr = Number(row.inline_link_click_ctr || 0);
    const linkClicks = Number(row.inline_link_clicks || 0);
    const age = ageDays[row.ad_id];
    allSpend += spend; allResults += results;
    if (isOurs(row)) { totalSpend += spend; totalResults += results; }

    let verdict = 'keep';
    const name = `"${row.ad_name}"`;
    if (!isOurs(row)) { verdict = NOT_JUDGED; notJudged++; }
    else if (spend < MIN_SPEND || (age !== undefined && age < MIN_AGE_DAYS)) verdict = 'too early';
    else if (!results && spend >= KILL_NO_RESULT) {
      if (linkClicks >= 20 && linkCtr >= 1) {
        // People ARE clicking — the ad is doing its job. Killing it would throw away the best
        // traffic; the leak is after the click.
        verdict = 'CHECK PAGE';
        recs.push(`CHECK YOUR PAGE for ${name} — ${linkClicks} people clicked (${linkCtr.toFixed(1)}% click rate) but none converted. The ad works; the page or checkout is the leak. Test the page on your phone before touching the ad.`);
      } else {
        verdict = 'SWITCH OFF';
        recs.push(`SWITCH OFF ${name} — ${money(spend)} spent, no results, and few clicks. Replace it with a new hook.`);
      }
    } else if (cost && results >= 2 && cost > TARGET * 1.5) { verdict = 'SWITCH OFF'; recs.push(`SWITCH OFF ${name} — ${money(cost)} per result across ${results} is well over your ${money(TARGET)} target.`); }
    else if (cost && cost <= TARGET * 0.6 && results >= 3) { verdict = 'SCALE'; recs.push(`SCALE ${name} +20% — ${money(cost)} per result across ${results}. Raise the ad set budget one step, then wait 3 days.`); }
    else if (freq > FATIGUE) { verdict = 'REFRESH'; recs.push(`REFRESH ${name} — people have seen it ${freq.toFixed(1)} times. Swap the hook, not the targeting.`); }
    else if (cost && results < 2) verdict = 'watching';

    lines.push(`${(row.ad_name || '?').slice(0, 26)} · ${money(spend)} · ${results} results · ${cost ? money(cost) + ' ea' : '—'} · freq ${freq.toFixed(1)} -> ${verdict}`);
  }

  const sum = (sp, re) => `${money(sp)} · ${re} results · ${re ? money(sp / re) + ' average' : 'no results yet'}`;
  lines.push('', `Total: ${sum(allSpend, allResults)}`);
  // With a mix, add the engine's own share on its own line — a blended average says little.
  if (notJudged && notJudged < rows.length) lines.push(`For the ads in the campaigns I set up: ${sum(totalSpend, totalResults)}`);
  const quietLine = notJudged === rows.length
    ? 'None of these ads are in the campaigns I set up, so I haven\'t judged them — judge each by its own goal (cost per lead or per sale).'
    : 'Nothing has crossed a threshold — let it run.';
  lines.push('', recs.length ? 'What I\'d do:' : quietLine);
  for (const rec of recs) lines.push('• ' + rec);
  if (recs.length) lines.push('', '(I haven\'t changed anything — these are yours to approve.)');

  const out = lines.join('\n');
  console.log('\n' + out);
  // --quiet: an on-screen read (e.g. for the dashboard) — don't also buzz their phone.
  if (!process.argv.includes('--quiet')) await sendTelegram(out.length > 3500 ? out.slice(0, 3400) + '\n…(truncated)' : out, env);
}

const cmd = process.argv[2];
const run = { check, setup, upload, monitor }[cmd];
if (!run) {
  console.log('Usage: node system/meta-ads.js <check|setup|upload|monitor>');
  process.exit(1);
}
run().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
