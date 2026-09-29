// Read the seller's customer-service inbox (IMAP) so the assistant can draft replies.
//
// READ-ONLY BY DESIGN. This file fetches and marks nothing as read, deletes nothing, and sends
// nothing. Replies go out through lib/email.js only after the seller approves them.
//
// Requires GMAIL_USER + GMAIL_APP_PASSWORD in .env (an APP password, not their normal Google
// password — saved through the Gmail card on the connect page). Works with any IMAP host via IMAP_HOST/IMAP_PORT.

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
    // A non-Gmail inbox (IMAP_HOST set) usually shares the SMTP login saved on the email card.
    pass: e.GMAIL_APP_PASSWORD || (e.IMAP_HOST ? e.EMAIL_PASS : undefined),
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
    return { ok: false, reason: 'GMAIL_USER / GMAIL_APP_PASSWORD not set yet — add them on the Gmail card of the connect page (ask your assistant to open the connect page).' };
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
      const msg = await client.fetchOne(String(uid), { bodyStructure: true, envelope: true }, { uid: true });
      if (!msg) return { ok: false, reason: 'message not found' };
      // Find the plain-text part (fall back to HTML) and let imapflow DECODE it — raw MIME is often
      // base64 or quoted-printable, which reads as gibberish.
      const parts = [];
      (function walk(node) {
        if (!node) return;
        if (node.childNodes) node.childNodes.forEach(walk);
        else parts.push(node);
      })(msg.bodyStructure);
      const pick = parts.find((p) => p.type === 'text/plain') || parts.find((p) => p.type === 'text/html');
      let text = '';
      if (pick) {
        const { content } = await client.download(String(uid), pick.part || '1', { uid: true });
        const chunks = [];
        for await (const ch of content) chunks.push(ch);
        text = Buffer.concat(chunks).toString('utf8');
        if (pick.type === 'text/html') text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
      }
      const env_ = msg.envelope || {};
      return { ok: true, text: text.trim().slice(0, 6000), subject: env_.subject || '', messageId: env_.messageId || '' };
    } finally { lock.release(); }
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  } finally {
    try { await client.logout(); } catch { /* already closed */ }
  }
}

module.exports = { recent, body, isConfigured };
