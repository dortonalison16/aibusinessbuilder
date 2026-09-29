// Meta ads runtime for the Automated (Auto-Pilot) edition.
//
//   node system/meta-ads.js check                 read-only: account, currency, pixel events
//   node system/meta-ads.js setup                 create the campaign + ad set, PAUSED
//   node system/meta-ads.js upload                turn finished creatives into PAUSED ads
//   node system/meta-ads.js monitor [--days 7]    read-only daily analysis -> Telegram
//
// EVERYTHING IS CREATED PAUSED. This file never enables an ad, never raises a budget, and never
// spends money. The monitor is strictly read-only and only ever *recommends* — because thresholds
// are guesses until there's real data, and an automated killer acting on guessed thresholds will
// confidently turn off a winner that simply hadn't converted yet.
//
// Creatives are picked up from  Content/ads/<campaign>/  with a copy sidecar per creative:
//     my-ad.png            the image (4:5). my-ad-9x16.png is used for stories/reels if present.
//     my-ad.mp4            or a video instead
//     my-ad.txt            REQUIRED — HEADLINE: / DESCRIPTION: / --- / body copy
// Uploaded files move to  Content/ads/<campaign>/_uploaded/  so a re-run can't double-post.

const fs = require('fs');
const path = require('path');
const { loadEnv, sendTelegram } = require('./lib/telegram');
const { guardOrExit } = require('./lib/working-hours');

const V = 'v21.0';
const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'ads-state.json');
const ADS_DIR = path.join(ROOT, 'Content', 'ads');

const env = loadEnv();
const TOKEN = env.META_ADS_TOKEN || env.META_PAGE_TOKEN;
const ACCOUNT = env.META_AD_ACCOUNT_ID;
const PAGE_ID = env.META_PAGE_ID;
const PIXEL_ID = env.META_PIXEL_ID;
const IG_ID = env.IG_USER_ID || '';

const money = (n) => '$' + Number(n || 0).toFixed(2);
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

function needCreds() {
  const missing = [];
  if (!TOKEN) missing.push('META_ADS_TOKEN');
  if (!ACCOUNT) missing.push('META_AD_ACCOUNT_ID');
  if (!PAGE_ID) missing.push('META_PAGE_ID');
  if (missing.length) {
    console.log(`Meta ads not connected yet — missing ${missing.join(', ')} in .env.`);
    console.log('Run the "Connect accounts" step (setup-connections, step 7) and I\'ll walk you through it.');
    process.exit(0);
  }
}

async function graph(node, method = 'GET', params = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  body.set('access_token', TOKEN);
  const url = `https://graph.facebook.com/${V}/${node}`;
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Meta ${method} ${node}: ${(j.error && j.error.message) || res.status}`);
  return j;
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
  console.log(`Status     : ${acct.account_status === 1 ? 'active' : 'code ' + acct.account_status}`);
  console.log(`Timezone   : ${acct.timezone_name}`);

  if (!PIXEL_ID) { console.log('\nNo META_PIXEL_ID set — add it so conversions can be tracked.'); return; }
  try {
    const since = new Date(Date.now() - 28 * 864e5).toISOString();
    const s = await graph(`${PIXEL_ID}/stats`, 'GET', { aggregation: 'event', start_time: since });
    const totals = {};
    for (const row of s.data || []) for (const d of row.data || []) totals[d.value] = (totals[d.value] || 0) + Number(d.count || 0);
    const seen = Object.entries(totals);
    console.log(`\nPixel events (last 28 days): ${seen.length ? seen.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`);
    const real = seen.filter(([k]) => k !== 'PageView');
    if (!real.length) {
      console.log('\n⚠️  The pixel has only ever fired PageView.');
      console.log('    A campaign optimizing for leads or purchases CANNOT learn from this — but it will');
      console.log('    still spend, on whoever is cheapest to reach. Fix it first with a Custom Conversion');
      console.log('    built on your thank-you page URL (Events Manager -> Custom Conversions), then put');
      console.log('    its id in ads-state.json as customConversionId. Ask me and I\'ll walk you through it.');
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
  const key = process.argv.includes('--name') ? process.argv[process.argv.indexOf('--name') + 1] : 'leads';
  const budgetArg = process.argv.includes('--budget') ? Number(process.argv[process.argv.indexOf('--budget') + 1]) : 20;
  const destination = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : null;

  if (!destination) { console.log('Need --url <your landing page>. Example:\n  node system/meta-ads.js setup --name leads --budget 20 --url https://yoursite.com/free'); return; }
  if (state[key] && state[key].adsetId) { console.log(`"${key}" already exists (campaign ${state[key].campaignId}). Nothing to do — new creatives go into that same ad set.`); return; }

  const cc = state.customConversionId || null;
  if (!cc) {
    console.log('⚠️  No customConversionId in ads-state.json.');
    console.log('    If your funnel only fires PageView, the ad set will spend without learning.');
    console.log('    Run "check" first. Continuing anyway — but everything stays PAUSED.\n');
  }

  const campaign = await graph(`${ACCOUNT}/campaigns`, 'POST', {
    name: `Ads — ${key}`, objective: 'OUTCOME_LEADS', status: 'PAUSED', special_ad_categories: [],
  });

  const targeting = {
    geo_locations: { countries: (env.ADS_COUNTRIES || 'US,CA,GB,AU').split(',').map((c) => c.trim()) },
    age_min: Number(env.ADS_AGE_MIN || 30),
    age_max: Number(env.ADS_AGE_MAX || 55),
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

  const adset = await graph(`${ACCOUNT}/adsets`, 'POST', {
    name: `${key} — evergreen`, campaign_id: campaign.id, status: 'PAUSED',
    billing_event: 'IMPRESSIONS', optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE',
    promoted_object: cc ? { custom_conversion_id: cc } : { pixel_id: PIXEL_ID, custom_event_type: 'LEAD' },
    daily_budget: Math.round(budgetArg * 100),
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting,
  });

  state[key] = { campaignId: campaign.id, adsetId: adset.id, destination, createdAt: new Date().toISOString() };
  writeState(state);
  console.log(`\n✅ Created PAUSED: campaign ${campaign.id}, ad set ${adset.id} at ${money(budgetArg)}/day.`);
  console.log('   Nothing will spend until you switch it on yourself:');
  console.log(`   https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${ACCOUNT.replace('act_', '')}`);
}

// ── upload ──────────────────────────────────────────────────────────────────────────────────────
function readCopy(dir, base) {
  for (const ext of ['.txt', '.md']) {
    const p = path.join(dir, base + ext);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    const parts = raw.split(/^---\s*$/m);
    const head = parts[0];
    const grab = (k) => { const m = head.match(new RegExp('^' + k + ':\\s*(.+)$', 'im')); return m ? m[1].trim() : ''; };
    return { headline: grab('HEADLINE'), description: grab('DESCRIPTION'), message: (parts.slice(1).join('---') || head).trim() };
  }
  return null;
}

async function uploadImage(file) {
  const j = await graph(`${ACCOUNT}/adimages`, 'POST', { bytes: fs.readFileSync(file).toString('base64') });
  const first = Object.values(j.images || {})[0];
  if (!first || !first.hash) throw new Error('image upload returned no hash');
  return first.hash;
}

async function upload() {
  needCreds();
  const state = readState();
  const keys = Object.keys(state).filter((k) => state[k] && state[k].adsetId);
  if (!keys.length) { console.log('No campaign yet — run "setup" first.'); return; }

  let made = 0;
  for (const key of keys) {
    const dir = path.join(ADS_DIR, key);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); continue; }
    const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f) && !/-(9x16|vertical|story)\./i.test(f));
    if (!files.length) { console.log(`${key}: nothing waiting in Content/ads/${key}/`); continue; }

    for (const file of files) {
      const base = file.replace(/\.[^.]+$/, '');
      const copy = readCopy(dir, base);
      if (!copy || !copy.message) { console.log(`  ! ${file}: no ${base}.txt copy file — skipped`); continue; }
      try {
        const hash = await uploadImage(path.join(dir, file));
        const creative = await graph(`${ACCOUNT}/adcreatives`, 'POST', {
          name: base.slice(0, 100),
          url_tags: `utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_id={{campaign.id}}&ad_id={{ad.id}}&adset_id={{adset.id}}`,
          object_story_spec: {
            page_id: PAGE_ID,
            ...(IG_ID ? { instagram_user_id: IG_ID } : {}),
            link_data: {
              image_hash: hash, link: state[key].destination, message: copy.message,
              name: copy.headline, description: copy.description,
              call_to_action: { type: 'LEARN_MORE', value: { link: state[key].destination } },
            },
          },
        });
        const ad = await graph(`${ACCOUNT}/ads`, 'POST', {
          name: base.slice(0, 100), adset_id: state[key].adsetId, creative: { creative_id: creative.id }, status: 'PAUSED',
        });
        console.log(`  ✓ PAUSED ad created: ${base} (${ad.id})`);
        made++;
        const done = path.join(dir, '_uploaded');
        fs.mkdirSync(done, { recursive: true });
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (f.indexOf(base) === 0 && fs.statSync(full).isFile()) fs.renameSync(full, path.join(done, f));
        }
      } catch (e) { console.log(`  ! ${file}: ${e.message}`); }
    }
  }
  if (made) {
    console.log(`\n✅ ${made} new ad(s), all PAUSED. Review and enable the ones you want.`);
    await sendTelegram(`${made} new Meta ad(s) uploaded and PAUSED. Review them in Ads Manager when you get a minute — nothing is spending yet.`, env);
  }
}

// ── monitor ─────────────────────────────────────────────────────────────────────────────────────
// READ-ONLY. Recommends; never acts. Refuses to judge anything on thin data, because killing a
// good ad after a few dollars of spend is the most common way people waste money on ads.
async function monitor() {
  needCreds();
  guardOrExit('ads-monitor');
  const days = process.argv.includes('--days') ? Number(process.argv[process.argv.indexOf('--days') + 1]) : 7;
  const MIN_SPEND = Number(env.ADS_MIN_SPEND_BEFORE_JUDGING || 20);
  const KILL_NO_RESULT = Number(env.ADS_KILL_SPEND_NO_RESULT || 30);
  const TARGET = Number(env.ADS_TARGET_COST_PER_RESULT || 12);
  const FATIGUE = 2.5;

  const r = await graph(`${ACCOUNT}/insights`, 'GET', {
    level: 'ad', date_preset: `last_${days}d`, limit: 200,
    fields: 'ad_name,campaign_name,spend,impressions,clicks,ctr,frequency,actions',
  });
  const rows = r.data || [];
  if (!rows.length) {
    console.log(`No ad delivery in the last ${days} days — campaigns are paused or haven't spent.`);
    return;
  }

  const resultOf = (row) => {
    const wanted = ['lead', 'offsite_conversion.fb_pixel_lead', 'complete_registration',
      'offsite_conversion.fb_pixel_complete_registration', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
    for (const a of row.actions || []) if (wanted.indexOf(a.action_type) !== -1) return Number(a.value || 0);
    return 0;
  };

  const lines = [`Meta ads — last ${days} days`];
  const recs = [];
  let totalSpend = 0, totalResults = 0;

  for (const row of rows.sort((a, b) => Number(b.spend) - Number(a.spend))) {
    const spend = Number(row.spend || 0);
    const results = resultOf(row);
    const cost = results ? spend / results : null;
    const freq = Number(row.frequency || 0);
    totalSpend += spend; totalResults += results;

    let verdict = 'keep';
    if (spend < MIN_SPEND) verdict = 'too early';
    else if (!results && spend >= KILL_NO_RESULT) { verdict = 'KILL'; recs.push(`KILL "${row.ad_name}" — ${money(spend)} spent, no results.`); }
    else if (cost && cost > TARGET * 1.5) { verdict = 'KILL'; recs.push(`KILL "${row.ad_name}" — ${money(cost)} per result is well over your ${money(TARGET)} target.`); }
    else if (cost && cost <= TARGET * 0.6 && results >= 3) { verdict = 'SCALE'; recs.push(`SCALE "${row.ad_name}" +25% — ${money(cost)} per result across ${results}. Raise it one step, then wait 3 days.`); }
    else if (freq > FATIGUE) { verdict = 'REFRESH'; recs.push(`REFRESH "${row.ad_name}" — people have seen it ${freq.toFixed(1)} times. Swap the hook, not the targeting.`); }

    lines.push(`${(row.ad_name || '?').slice(0, 26)} · ${money(spend)} · ${results} results · ${cost ? money(cost) + ' ea' : '—'} · freq ${freq.toFixed(1)} -> ${verdict}`);
  }

  lines.push('', `Total: ${money(totalSpend)} · ${totalResults} results · ${totalResults ? money(totalSpend / totalResults) + ' average' : 'no results yet'}`);
  lines.push('', recs.length ? 'What I\'d do:' : 'Nothing has crossed a threshold — let it run.');
  for (const rec of recs) lines.push('• ' + rec);
  if (recs.length) lines.push('', '(I haven\'t changed anything — these are yours to approve.)');

  const out = lines.join('\n');
  console.log('\n' + out);
  await sendTelegram(out.length > 3500 ? out.slice(0, 3400) + '\n…(truncated)' : out, env);
}

const cmd = process.argv[2];
const run = { check, setup, upload, monitor }[cmd];
if (!run) {
  console.log('Usage: node system/meta-ads.js <check|setup|upload|monitor>');
  process.exit(1);
}
run().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
