// Read the seller's customer-service inbox (IMAP) so the assistant can draft replies.
//
// READ-ONLY BY DESIGN. This file fetches and marks nothing as read, deletes nothing, and sends
// nothing. Replies go out through lib/email.js only after the seller approves them.
//
// Requires GMAIL_USER + GMAIL_APP_PASSWORD in .env (an APP password, not their normal Google
// password — see setup-connections step 6). Works with any IMAP host via IMAP_HOST/IMAP_PORT.

const { loadEnv } = require('./telegram');

// Lazy-required, exactly like nodemailer in lib/email.js, so a missing optional dependency gives
// a friendly instruction instead of a stack trace on a buyer's laptop.
function getImapFlow() {
  try {
    return require('imapflow').ImapFlow;
  } catch {
    return null;
  }
}

function config(env) {
  const e = env || loadEnv();
  return {
    user: e.GMAIL_USER || e.EMAIL_USER,
    pass: e.GMAIL_APP_PASSWORD,
    host: e.IMAP_HOST || 'imap.gmail.com',
    port: Number(e.IMAP_PORT || 993),
  };
}

function isConfigured(env) {
  const c = config(env);
  return Boolean(c.user && c.pass);
}

// Fetch the most recent messages from the inbox. Returns { ok, messages } where each message is
// { from, subject, date, preview } — enough for the assistant to triage and draft, without
// dragging entire threads into context.
async function recent({ limit = 15, unreadOnly = false, env } = {}) {
  if (!isConfigured(env)) {
    return { ok: false, reason: 'GMAIL_USER / GMAIL_APP_PASSWORD not set in .env — run the customer-service email step in setup-connections.' };
  }
  const ImapFlow = getImapFlow();
  if (!ImapFlow) {
    return { ok: false, reason: 'The inbox reader needs one small one-time install. Run: npm install imapflow  (inside the system folder), then try again.' };
  }

  const c = config(env);
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: true,
    auth: { user: c.user, pass: c.pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      if (!total) return { ok: true, messages: [] };

      const seq = `${Math.max(1, total - (limit * 3) + 1)}:*`;
      const out = [];
      for await (const msg of client.fetch(seq, { envelope: true, flags: true, bodyStructure: false })) {
        const isUnread = !(msg.flags && msg.flags.has('\\Seen'));
        if (unreadOnly && !isUnread) continue;
        const env_ = msg.envelope || {};
        const from = (env_.from && env_.from[0]) || {};
        out.push({
          uid: msg.uid,
          unread: isUnread,
          from: from.address || 'unknown',
          fromName: from.name || '',
          subject: env_.subject || '(no subject)',
          date: env_.date ? new Date(env_.date).toISOString() : null,
        });
      }
      // Newest first, capped.
      out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      return { ok: true, messages: out.slice(0, limit) };
    } finally {
      lock.release();
    }
  } catch (e) {
    let reason = e.message || String(e);
    if (/auth/i.test(reason)) {
      reason = 'Login failed. Two usual causes: (1) it needs an APP password, not the normal Google password; (2) 2-Step Verification has to be on before Google will issue one.';
    }
    return { ok: false, reason };
  } finally {
    try { await client.logout(); } catch { /* already closed */ }
  }
}

// Fetch one message's text body, for drafting a reply to a specific customer.
async function body({ uid, env } = {}) {
  if (!isConfigured(env)) return { ok: false, reason: 'inbox not configured' };
  const ImapFlow = getImapFlow();
  if (!ImapFlow) return { ok: false, reason: 'run: npm install imapflow' };

  const c = config(env);
  const client = new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg) return { ok: false, reason: 'message not found' };
      const raw = msg.source.toString('utf8');
      // Strip headers — the assistant only needs what the customer actually wrote.
      const split = raw.indexOf('\r\n\r\n');
      const text = (split > -1 ? raw.slice(split + 4) : raw).replace(/=\r\n/g, '').slice(0, 6000);
      return { ok: true, text };
    } finally { lock.release(); }
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  } finally {
    try { await client.logout(); } catch { /* already closed */ }
  }
}

module.exports = { recent, body, isConfigured };
