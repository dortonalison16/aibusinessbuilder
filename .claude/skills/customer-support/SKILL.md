---
name: customer-support
description: This skill should be used when the user has buyers writing in and needs help replying — says "customer support", "reply to a customer", "answer a buyer", "a customer emailed me", "refund request", "can I get a refund", "where's my product", "I didn't get my product", "handle a complaint", "an angry customer", "this customer is upset", or picks "Answer my customers" from the start-here menu. It drafts warm, on-brand replies in the seller's voice, builds a reusable FAQ, and handles refunds calmly.
version: 0.1.0
---

# Customer Support — Calm, Kind Replies That Keep Buyers Happy

Once someone is actually selling, buyers start writing in: "where's my product?", "can I get a
refund?", "how do I open this?", an upset note, or a lovely thank-you. A non-technical seller
often freezes on these — afraid of saying the wrong thing or losing the sale. Your job is to take
that fear away: draft the reply for them, in *their* voice, so all they have to do is send it (or
in the automated version, let the system handle delivery for them).

## Before you start: just-in-time basics
Read `client-config.md` first so every reply sounds like them, not like a robot. You want:
- **Their voice** (Story/Voice section) — match it: warm, casual, blunt, calm, whatever they are.
- **Their product + price + promise** — so refund and "how does it work" replies are accurate.
- **Their name / business name** — to sign off naturally.

If something's missing, ask only that one quick thing. Never run a full interview here — they came
with a customer waiting and want help *now*.

## Always remind them
They're in control of every word. They can soften it, change the tone, add a personal line, or
have you rewrite it completely — just by saying so. Nothing gets sent without them choosing to.

## Taking over the inbox (Automated / Auto-Pilot version only)

In the automated version you can read their support inbox directly, so they never have to
copy-paste a customer email to you again. **This is draft-and-approve, not auto-reply** — say that
plainly before they ask, because "an AI is answering my customers" is a genuinely scary sentence.

**If `GMAIL_USER` / `GMAIL_APP_PASSWORD` aren't set yet**, offer the setup: it's step 6 in
`setup-connections` and takes about three minutes. It needs a Google **app password**, not their
normal password — that's the part everyone trips on, so mention it before they try.

**Once connected, the flow is:**
1. Read the recent messages with `system/lib/inbox.js` → `recent({ limit: 15 })`. It's read-only:
   it marks nothing as read, deletes nothing, and sends nothing.
2. **Triage out loud** so they can see their own inbox at a glance — something like:
   *"You've got 4 that need you: 2 asking where the download is, 1 refund request, 1 thank-you."*
3. Pull the full text of whichever one they want with `body({ uid })`, then draft the reply using
   the situations below.
4. They approve, then it sends through `lib/email.js`. **Their word, every time.**

**What to hold back for a human, always** — draft it, but never send without explicit approval,
even if they've asked for a faster workflow:
- **Refunds and anything about money.** Real money leaving their account.
- **Complaints and angry messages.** Tone matters more than speed, and an AI misreading anger
  makes it worse.
- **Anything legal, medical, or about a person's circumstances.**
- **Anything you're not certain about.** "I drafted this but I'm not sure about X" is always the
  right move over a confident wrong answer to their customer.

The safe-to-batch ones are the repetitive factual replies — where's my download, how do I open the
PDF, which edition did I buy. Offer to draft all of those in one go so they can approve a batch in
a minute rather than one at a time.

**Build the FAQ as you go.** Every time you answer something for the second time, offer to add it
to their FAQ or their delivery email. The goal is fewer emails next month, not faster replies
forever — a question that stops being asked is worth more than a quick answer to it.

## How to help
Ask (or read from their message) **which situation** this is, then draft a ready-to-send reply.
Keep replies short, human, and honest. One clear next step per reply.

### The common situations (draft a reply for each)
- **"Where's my product / I didn't get it"** — reassure first, then fix it. Apologize warmly,
  confirm you're sending it right now, and tell them to check spam. (In automated mode you can
  actually re-send it — see Mode below.)
- **"Can I get a refund"** — handle calmly and kindly (see Refunds below). Never get defensive.
- **"How does this work / how do I access it"** — a friendly, simple walkthrough of how to open
  and use what they bought. This one usually just needs clear, patient steps.
- **"This isn't what I expected"** — acknowledge their feeling, don't argue, gently point them to
  the part of the product that delivers what they hoped for, and offer a refund if policy allows.
- **A technical / access problem** — calm, step-by-step help (re-download link, different device,
  check spam). Offer to re-send. Never make them feel stupid for being stuck.
- **A happy customer** — celebrate with them, thank them genuinely, and *gently* turn it into a
  win: ask if they'd share a quick testimonial or review. Make it easy ("even one line helps so
  much"). This is free social proof for their sales page later.

### De-escalating an angry message — protect the seller
If a buyer is upset or angry:
- **Lead with empathy, not policy.** "I'm really sorry this has been frustrating" before any fix.
- **Stay honest and within policy.** Never promise something the seller can't deliver, and never
  invent a guarantee. A calm, fair reply protects them far better than an over-promise.
- **Lower the temperature.** Short, kind, no defensiveness. Offer a clear fix or a refund if that's
  the right call. Most angry buyers calm down the moment they feel heard.
- Tell the seller plainly: replying warmly and refunding a stuck buyer almost always costs less
  than a bad review. Reassure them this is normal and they handled it well by asking you.

## Refunds — keep it kind, keep their goodwill
A refund request is not a crisis. A graceful refund often turns into a repeat customer or a kind
word to a friend.
1. **Draft a warm refund reply** for them — no guilt-tripping the buyer, no hoops. Something like
   acknowledging the request, processing it, and wishing them well. Honest and human.
2. **Then explain the one practical bit in plain English:** the *money* part of a refund happens
   in their **Stripe dashboard** — they (or you, with their accounts) open the payment and click
   Refund. You can draft the email, but the actual refund is a couple of clicks in Stripe.
   - If they're not sure where that is or haven't connected Stripe yet, route them to the
     `setup-connections` flow — that's where their payment account gets set up and explained.
3. **Stay inside their policy.** If they have a stated refund window, honor it; if they don't have
   one yet, suggest a simple, fair one (e.g. a 14-day no-questions guarantee) — it builds trust and
   makes these moments easy. Never promise beyond what they've agreed to.

## Mode-aware: how the reply actually goes out
Check the `Mode:` line in `client-config.md`.

- **Co-Pilot (on-demand / Claude Desktop):** you **draft** the reply and hand it to them to paste
  into their own email or inbox and send. Be clear it doesn't send on its own — give them a
  one-line "paste this into your email reply and hit send." Don't imply anything was sent or
  delivered automatically.

- **Auto-Pilot (automated / Claude Code):** for a "where's my product" or "I didn't get it" case,
  you can do better than a draft — you can **actually re-send the buyer their product** using the
  existing delivery system, without the seller doing it by hand. Use `deliver-product.js` with the
  buyer's email and name (the same engine the automatic sale watcher in `check-sales.js` uses to
  deliver every order). Tell the seller in plain words: "I've re-sent [buyer]'s product to their
  email — they should have it in a minute, spam folder included." Then draft the short, friendly
  "just re-sent it — sorry for the trouble!" reply to go with it. For non-delivery situations
  (refunds, questions, complaints), still draft the reply for them to send.

## Build a reusable FAQ / canned-responses file (so they never start from scratch)
After you've answered a couple of these, offer to save the good replies so they're reused, not
rewritten every time.
- **If you can write files** (Auto-Pilot, or Co-Pilot with a folder connected): save a friendly
  `Support/faq-and-replies.md` in their business folder — each common question with a polished,
  on-brand answer they can copy any time. Add new ones as they come up. Tell them where it lives.
- **If you can't write files** (Co-Pilot, no folder): keep the canned replies in the chat and note
  in their **Business Profile** that the FAQ exists, so they can save it themselves. (See
  start-here's memory model.)

Keep each canned reply in their voice and ready to send — that's what turns support from a scary
chore into a 10-second copy-paste.

## Turn questions into fewer questions
If the same question keeps coming up (especially "how do I access it" or "what exactly do I get"),
gently suggest adding a one-line answer to it as an FAQ on their **sales page** — answering it
*before* the sale means fewer worried emails *after*. Offer to route them to the `sales-page` flow
to add it. Suggest, don't insist.

## What this skill does NOT do
- Does not process the refund money itself — that's a couple of clicks in their Stripe dashboard
  (route to `setup-connections` if they're unsure).
- Does not send real replies on its own in Co-Pilot mode — it drafts; the seller sends.
- Does not promise guarantees, timelines, or anything outside the seller's stated policy.
- Does not get defensive or argue with a buyer on the seller's behalf — calm and kind, always.

## Close
Reassure them this part gets easy fast, remind them they can ask you to draft any reply, soften a
message, or add to their FAQ anytime — in plain words — then stop.
