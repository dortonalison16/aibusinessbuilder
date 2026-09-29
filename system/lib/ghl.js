// GoHighLevel (or any CRM) hand-off — adds a buyer as a contact and tags them, so the seller's
// own email sequences fire automatically the moment someone buys.
//
// Entirely OPTIONAL. If GHL_TOKEN / GHL_LOCATION_ID aren't in .env, every function here returns a
// friendly "not configured" and the sale loop carries on exactly as before. Payment, delivery and
// the Telegram ping never depend on this.

const { loadEnv } = require('./telegram');

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

function creds(env) {
  const e = env || loadEnv();
  return { token: e.GHL_TOKEN, locationId: e.GHL_LOCATION_ID };
}

function isConfigured(env) {
  const { token, locationId } = creds(env);
  return Boolean(token && locationId);
}

async function call(pathStr, method, body, env) {
  const { token } = creds(env);
  // Never throw: the sale loop calls this between delivering a product and remembering the sale,
  // so an exception here (offline, DNS) would get the buyer emailed again on the next run.
  try {
    const res = await fetch(BASE + pathStr, {
      method,
      headers: { Authorization: 'Bearer ' + token, Version: VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { message: `couldn't reach GoHighLevel (${err.message})` } };
  }
}

// Upsert a buyer and tag them. GHL de-duplicates by email, so a repeat buyer updates their
// existing record rather than creating a second one — which is what you want.
async function addBuyer({ email, name, tags = [], env } = {}) {
  if (!isConfigured(env)) return { ok: false, reason: 'not configured' };
  if (!email) return { ok: false, reason: 'no email' };

  const { locationId } = creds(env);
  const [firstName, ...rest] = String(name || '').trim().split(/\s+/);
  const body = {
    locationId,
    email: String(email).trim().toLowerCase(),
    ...(firstName ? { firstName } : {}),
    ...(rest.length ? { lastName: rest.join(' ') } : {}),
    tags,
  };

  let r = await call('/contacts/', 'POST', body, env);

  // A duplicate is not an error — it means they already exist. Find them and add the tags.
  if (!r.ok && (r.status === 400 || r.status === 409)) {
    const dupId = r.data && r.data.meta && r.data.meta.contactId;
    if (dupId) {
      // ADD tags (never PUT { tags } — that REPLACES every tag they already have, which would
      // silently pull a repeat buyer out of the seller's other sequences).
      const upd = await call('/contacts/' + dupId + '/tags', 'POST', { tags }, env);
      return upd.ok
        ? { ok: true, contactId: dupId, existing: true }
        : { ok: false, reason: 'found existing contact but could not tag it' };
    }
  }

  if (!r.ok) {
    const msg = (r.data && (r.data.message || r.data.error)) || ('status ' + r.status);
    return { ok: false, reason: Array.isArray(msg) ? msg.join('; ') : String(msg) };
  }
  return { ok: true, contactId: r.data && r.data.contact && r.data.contact.id };
}

// Read-only connection test — used by the connect page and health check so the buyer sees proof it works before
// anything is written to their CRM.
async function testConnection(env) {
  if (!isConfigured(env)) return { ok: false, reason: 'GHL_TOKEN / GHL_LOCATION_ID not set in .env' };
  const { locationId } = creds(env);
  const r = await call('/contacts/?locationId=' + locationId + '&limit=1', 'GET', null, env);
  if (!r.ok) return { ok: false, reason: (r.data && r.data.message) || ('status ' + r.status) };
  const total = (r.data && r.data.meta && r.data.meta.total);
  return { ok: true, contactCount: typeof total === 'number' ? total : 'unknown' };
}

module.exports = { addBuyer, testConnection, isConfigured };
