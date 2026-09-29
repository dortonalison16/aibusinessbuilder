---
name: setup-connections
description: This skill should be used when the user is ready to connect their tools and go live — says "connect my accounts", "set up the tech", "hook everything up", "go live", "the connections step", "set up reporting", or finishes earlier phases and asks "what now". It hand-holds a non-technical person through connecting their own accounts, pasting their own keys, and turning on optional Telegram reporting.
version: 0.1.0
---

# Setup & Connections — The Hand-Held Go-Live

This is the phase where non-technical buyers either succeed or get stuck and ask for a refund. Treat it with extreme care. **Go slow, one connection at a time, celebrate each small win, and never assume they know a technical term.**

## Iron rules

1. **Their accounts, their keys — never yours.** Every credential they paste is their own. You never provide, suggest, or reuse any **API key, password, or login** that isn't theirs. *(This is about credentials — NOT signup links. It is good and expected to point them to the recommended tools' **signup links** so they create their **own** account; see "Recommend the right tools" below. Never share the seller's keys/logins; do share the seller's signup links.)*
2. **One connection at a time.** Never show a list of 6 things to set up. Do one, confirm it works, then offer the next.
3. **Show, don't tell.** For each step give the *exact* clicks: "Go to [site] → click the blue **Settings** button top-right → click **API Keys**." Screenshots-in-words.
4. **Test immediately.** After each connection, run a tiny test and report "✅ Connected!" or a plain-English fix. Never leave them wondering if it worked.
5. **Everything is skippable.** Each connection is optional and clearly labelled. They can go live with the bare minimum and add the rest later.
6. **Secrets go in a local file, never in chat history.** Store keys in a local `.env` file in their folder; tell them it stays on their computer and is never shared.
7. **Keep reminding them they can ask for anything, anytime.** This phase is the scariest for non-technical people, so reassure often: if they're stuck, confused, want to skip something, change their hours, or have you adjust how anything runs — they just say it in plain words and you handle it. They never have to figure it out alone.

## Recommend the right tools (naturally, with the setup links)
As tools come up during setup — a funnel host, a scheduler/poster, a voice tool, etc. — point the buyer to the recommended one using the **setup links** in `references/recommended-tools.md`. This is a normal, helpful part of getting them live, **not a pitch** — do it lightly and only when the tool is actually the next thing they need.
- **Present links with the URL hidden.** Always use markdown so only a word is clickable: `Set up your Metricool account [here](https://f.mtr.cool/MZQGFM).` The buyer sees *"…[here]"* — never the raw URL.
- **One at a time, at the moment it's needed.** Recommend the tool for the step you're on, note its free tier, keep it skippable. Never dump the whole list; never pressure. If they already have that account, skip it warmly.
- **Signup links, not credentials** (Iron Rule #1 still holds): these help the buyer make their OWN account; you never share the seller's keys or logins.
- The two that come up most: **GoHighLevel** (funnel + delivery — at the sales-page/funnel step) and **Metricool** (scheduling + auto-posting — at the social step; it's the one that keeps trending audio on Reels). Full list + suggested phrasing: `references/recommended-tools.md`.

## Which version this is for
This connections/automation flow is for the **Automated Version (Claude Code)** — it runs
scripts and schedules jobs. **If `client-config.md` says `Mode: on-demand/Desktop`, STOP and
use the Desktop path below — do NOT run any `system/` script, and never show a `node`/`npm`
command to a Desktop user (their app can't run them, and it's the fastest way to lose them).**

**Desktop (Co-Pilot) "go live" instead:** auto-scheduling, sale alerts, and auto-delivery are
Automated-Version features. Here you help them get *sellable* by hand — confirm their product,
sales page, and emails are ready (built in earlier phases), then walk them, in their OWN
dashboards with plain clicks, through (a) setting up checkout/payment in Stripe or their funnel
tool, and (b) putting their product file somewhere they can email or link to a buyer. You draft
everything; they paste and click. Reassure them this is fully workable — and that the hands-free
version (auto-deliver, auto-post, sale texts) is the Auto-Pilot upgrade whenever they want it.

## Prerequisite check (automated version)
Assumes Claude Code is installed and they opened it inside their business folder (Track B of
`GET-STARTED.md` handles that *before* this phase, since they can't run a skill until the
assistant exists). If they seem lost, point them back to that guide kindly.

## Order of connections (easiest + most essential first)

Always present in this order. Stop and confirm after each.

### 0a. Set your working hours (DO THIS FIRST — it makes everything else reliable)
Automations can only run when their computer is **on and awake**. So before scheduling
anything, find out their real availability.
- Ask warmly: "When is your computer usually on and awake? I'll only schedule things to
  run during those hours so they actually happen — never at 3am when your laptop's asleep."
- Get **which days** and a **start/end time** (e.g. weekdays 9am–5pm, or "Mon–Thu 10–4").
- Write it into `system/working-hours.json` (days as Mon/Tue/… codes, 24-hour start/end).
- Reassure: "You can change this anytime — just tell me your new hours and I'll reschedule
  everything for you."
- From now on, **every scheduled automation goes through `system/schedule-automation.js`**,
  which only registers jobs inside this window and adds a safety guard so nothing runs
  off-hours even if the computer wakes oddly. Never hand-write a schedule outside it.

### 0b. One-time PDF tooling (only if Phase 1 deferred it)
If the product was built as HTML because PDF tooling wasn't installed, do this first so they finally get their downloadable PDF.
- Explain in one line: "This is a quick one-time install so your product can become a real downloadable PDF."
- Walk the install, then **generate the PDF from the existing HTML** and show them the finished file. Big win — celebrate it. 🎉

### 1. Payment (so they can actually get paid) — ESSENTIAL
- Walk them through creating/connecting their **Stripe** account and getting their own secret key.
- Save it as `STRIPE_SECRET_KEY` in their local `.env` (copy `.env.template` → `.env` the first time).
- **Test it for real:** run `node system/check-stripe.js`. It calls Stripe read-only and reports
  ✅ connected (and whether they're in TEST or LIVE mode) or a plain-English fix. Don't move on
  until it's green.
- Reassure about test vs live mode in plain words.

### 2. Email delivery (so buyers receive the product) — ESSENTIAL
- First time only: make sure `.env` exists (copy `.env.template` → `.env`) and install the email
  engine: run `npm install` inside the `system/` folder (one-time, ~30 seconds).
- Walk them through their email account's **SMTP** details and save them in `.env`:
  `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_FROM`. Explain in plain words
  (an "app password" is usually needed — guide them to create one).
- **Test it for real:** run `node system/deliver-product.js <their own email> "<their name>"`.
  It sends them the exact delivery email a buyer gets (with the product attached if it's built).
  Have them confirm it arrived (check spam too). Don't move on until it lands. ✅

### 3. Sales page / funnel host — ESSENTIAL
- Connect or publish their sales page so there's a link to send traffic to.
- Confirm the live URL loads.

### 4. Telegram reporting (optional but loved) — ADVANCED, SKIPPABLE
This is the "feels like magic" connection. Frame it as a treat, and make clear they can skip it.
- Explain simply: "Want a little message on your phone every time you make a sale, plus a short weekly summary of how things are going? We can set that up in Telegram — it's free."
**Walk it exactly like this — one numbered step at a time, waiting for a "done" between each.**
Do NOT paste all six steps at once; that's what makes people bail. This is the step where a
non-technical buyer is most likely to feel out of their depth, so narrate every click.

> **Step 1 — Install Telegram.** Get it on your phone from the App Store or Play Store (it's
> free), and create an account if you don't have one. Tell me when you're in.

> **Step 2 — Find BotFather.** In Telegram, tap the 🔍 search icon at the top and type
> **BotFather**. Tap the result with the blue verified checkmark — that's the official one.
> (There are copycats; the checkmark matters.) Tap **Start** at the bottom.

> **Step 3 — Create your bot.** Send the message `/newbot`. It'll ask two things:
>   • **A name** — anything you like, e.g. *My Business Alerts*
>   • **A username** — must be unique and must end in `bot`, e.g. `ashlyn_sales_bot`
>   If it says the username is taken, just add a number and try again.

> **Step 4 — Copy your token.** BotFather replies with a message containing a long code that
> looks like `8123456789:AAF3xK...`. That's your **bot token**. Copy the whole thing.
> ⚠️ Treat it like a password — it goes in your own file on your own computer, never in a chat
> with anyone. Paste it to me only if you want me to save it for you; otherwise I'll tell you
> exactly where to put it.

> **Step 5 — Say hi to your bot.** In BotFather's message there's a link to your new bot
> (`t.me/your_bot_name`). Tap it, then tap **Start**, and send it any message — even just "hi".
> **This step is required.** Telegram won't let a bot message you until you've messaged it
> first, and skipping it is the #1 reason the test fails.

> **Step 6 — Get your chat ID.** This is the "address" for your phone. Easiest way: in Telegram,
> search for **@userinfobot**, tap Start, and it replies with your ID — a number like
> `123456789`. Copy it.

Then save both into their local `.env`:
- `TELEGRAM_BOT_TOKEN` = the code from Step 4
- `TELEGRAM_CHAT_ID` = the number from Step 6

- **Test it for real:** run `node system/test-telegram.js` and have them confirm the message
  landed on their phone. ✅ Don't move on until they see it.
- **If the test fails,** check these in order and say which one you're checking:
  1. Did they message the bot first (Step 5)? By far the most common miss.
  2. Any stray space or line break when the token/ID was pasted? Re-paste it.
  3. Is the chat ID a plain number, with no `@` and no quotes?
  4. Did they copy the *whole* token including the part before the colon?
- Celebrate when it lands — this is the step that makes the whole system feel real. 🎉
- Then wire two reports (both use `system/lib/telegram.js`, plain text only):
  - **Sale ping** — a short message on each new sale ("💸 New sale! [their product] — $[price]").
  - **Weekly digest** — a once-a-week summary (sales count, revenue, simple trend). Schedule it
    with `node system/schedule-automation.js add --name weekly-digest --script <job>.js --freq weekly --day <day>`
    so it lands inside their working hours.
- If they get stuck at any sub-step, offer to skip and revisit later — never let Telegram block go-live.

### 4b. Turn on auto-pilot (the sale → deliver → ping loop) — the magic moment
Once payments (1), delivery (2), and ideally Telegram (4) are green, switch on the loop that
makes this run itself. Explain it warmly: "From now on, when someone buys, your assistant will
automatically email them their product and text you that you made a sale — even while you sleep."
- Schedule the sale watcher (checks for new sales every hour; only acts during working hours):
  `node system/schedule-automation.js add --name sale-watch --script check-sales.js --freq hourly`
- Schedule the weekly summary (pick their day):
  `node system/schedule-automation.js add --name weekly-digest --script weekly-digest.js --freq weekly --day <day>`
- Confirm what's scheduled: `node system/schedule-automation.js list`
- How it works under the hood (reassure, don't overwhelm): it safely checks Stripe, never emails
  the same buyer twice, and skips anything outside their working hours.
- Remind them their computer must be on during their working hours for this to run, and that they
  can change hours or turn this off anytime by just asking.

**Make the sale ping CONFIRM delivery, not just announce the sale.** A message saying "you made a
sale!" is exciting; a message saying "sale made **and** product delivered" is the one that lets
them close the laptop. So the ping should report the whole chain, and flag it loudly if any link
broke — a silent delivery failure is a refund and a bad review they'd otherwise find out about
from an angry customer.

The ping should read like:
> 💸 **New sale — [product]** · $[amount]
> ✅ Product emailed to [buyer email]
> ✅ Added to your CRM and tagged
> Nothing needed from you.

And if something failed:
> 💸 **New sale — [product]** · $[amount]
> ⚠️ **Delivery FAILED** — [plain-English reason]
> Reply here and I'll fix it now. Your buyer has paid and hasn't got it yet.

If they use **GoHighLevel** (or another CRM), offer to add the buyer there too and tag them, so
their email sequences fire automatically:
- Walk them to GHL → **Settings → API Keys / Private Integrations** → create a token with contact
  read/write, and copy their **Location ID** from the same settings area.
- Save as `GHL_TOKEN` and `GHL_LOCATION_ID` in `.env`. Skippable — the sale ping and email
  delivery work fine without it.
- Test it by adding a test contact and confirming it appears in GHL, then confirm the tag landed.
- Explain the payoff in one line: "This is what makes your onboarding emails start automatically
  the moment someone buys, instead of you remembering to add them."

### 5. Social auto-posting (Facebook / Instagram) — OPTIONAL
Only if they want posts to go out automatically. **Safety first, always:** this stays in
**DRY-RUN (preview only)** until they personally decide to go live.
- Walk them through getting their **Facebook Page ID + Page access token** and (for Instagram)
  their **Instagram Business account ID**. Save as `META_PAGE_ID`, `META_PAGE_TOKEN`, `IG_USER_ID`
  in `.env`. Keep `SOCIAL_DRY_RUN=true`.
- Make sure they have content queued (the content creator writes `Content/content-plan.json`).
- **Preview it:** run `node system/social-post.js`. In dry-run it only **logs what it *would*
  post** and never posts publicly. Show them the preview so they trust it.
- Schedule the daily run (acts only within working hours):
  `node system/schedule-automation.js add --name social-post --script social-post.js --freq daily`
- **Going live is their explicit choice:** only when they say so, change `SOCIAL_DRY_RUN=false`
  in `.env`. Explain plainly what that means. Until then, nothing ever posts.
- For **Instagram** image auto-posting, also get a free **imgbb** key and save it as
  `IMGBB_API_KEY` (Instagram can only post from a public URL, so rendered images are hosted there
  first). Facebook doesn't need it.
- Honest limits of the built-in API poster: **video reels** and **trending-audio** reels can't go
  through the platform API cleanly (it strips the trending sound). **The easy fix is Metricool** —
  it schedules and auto-posts everything, including Reels that keep their trending audio. When the
  social step comes up, naturally offer it (URL hidden): *"The smoothest way to schedule and post all
  of this — and keep trending audio on your Reels — is Metricool. You can set up your account
  [here](https://f.mtr.cool/MZQGFM)."* Recommend once, note the free tier, never pushy. (See
  `references/recommended-tools.md`.)

### 6. Customer-service email (let your assistant handle the inbox) — OPTIONAL, loved
Once sales start, customer email becomes the surprise time-sink — and slow replies cause refunds.
Offer to take it over. Frame it honestly: **it drafts, they approve.** Nothing is sent to a real
customer without them seeing it first, and say so before they ask.

- Explain the payoff in one line: "I can read your support inbox, draft a warm reply to each one
  in your voice, and hand them to you to approve — so nobody waits two days for an answer."
- **Which inbox?** Use the address buyers actually reply to — usually the same one sending their
  delivery email. Keep support separate from personal email if they can.
- **Gmail setup** (walk it one step at a time, same as Telegram):
  1. Google Account → **Security** → turn on **2-Step Verification** if it isn't already
     (required — Google won't issue an app password without it).
  2. Same page → **App passwords** → create one, name it *AI Assistant*.
  3. Google shows a **16-character password**. Copy it — it's shown once and never again.
  4. Save as `GMAIL_USER` (the full address) and `GMAIL_APP_PASSWORD` in `.env`.
- ⚠️ **It must be an app password, not their normal Google password.** Their real password will
  simply fail, and this is the single most common stumble here. Say it before they try.
- **Test it read-only first:** fetch the most recent few messages and show the subject lines. Seeing
  their own inbox listed back proves it works without touching anything. ✅
- Then hand off to the `customer-support` flow for drafting. **Default to draft-and-approve.**
  Only ever move to auto-send if they explicitly ask, and even then keep refunds, complaints, and
  anything about money in the approval queue — those need a human.
- Skippable at any point. If Gmail 2FA turns into a wall, offer to come back to it later rather
  than losing the whole go-live session over an inbox.

### 7. Meta ads account (so your assistant can run paid traffic) — OPTIONAL, for later
Only set this up when they're actually ready to run ads — a product and a converting page come
first. If they aren't there yet, say so kindly and skip; ads that point at a leaky page just cost
money faster. See the `meta-ads` skill for the full flow.

- **What's needed** (all their own, from their own Business account):
  1. **Ad account ID** — business.facebook.com → Ads Manager → account dropdown. Starts with
     `act_`. Save the whole thing including the prefix.
  2. **Access token with ads permissions** — Business Settings → **System Users** → add a system
     user → **Generate token** → select their app → grant **ads_management** and **ads_read**
     (plus business_management). Walk this slowly; it's the fiddliest screen in the whole product.
  3. **Page ID** — their Facebook Page → About → Page transparency.
  4. **Pixel ID** — Events Manager → Data Sources. They likely already have one.
- Save as `META_AD_ACCOUNT_ID`, `META_ADS_TOKEN`, `META_PAGE_ID`, `META_PIXEL_ID` in `.env`.
  *(`META_PAGE_ID` may already be set from the social step — reuse it.)*
- **Test it read-only:** list their ad account name and currency back to them. Nothing is created,
  nothing spends. ✅
- **Note the currency out loud.** If the ad account's currency differs from the currency their
  product is priced in, conversion values get recorded in the *account's* currency and every
  campaign will look less profitable than it is. Flag it now, before it misleads them for a month.
- **Then check the pixel before promising anything.** Ask what events it has actually fired
  recently. If it has only ever fired `PageView` — very common with funnel builders — a campaign
  optimizing for leads or purchases **cannot learn but will still spend.** The fix is a Custom
  Conversion built on their thank-you page URL, and it's covered step-by-step in `meta-ads`.
  **Do not let them launch before this is sorted.**
- Reassure, twice if needed: **everything you create is PAUSED.** No ad ever goes live, and no
  money is ever spent, until they switch it on themselves in Ads Manager.

## Respect scheduling reality
Every scheduled job goes through `system/schedule-automation.js`, which only registers
tasks inside the working hours from Step 0a and tags each job's startup with a guard so it
won't run off-hours. Remind them plainly: **their computer must be on and awake during their
chosen hours** for local automations to fire. If they want things to run even when their
computer is off, that needs an always-on/cloud setup — name it as a future option, don't
silently pretend local scheduling covers it.

## Closing
When the essentials (payment + delivery + sales page) are green, declare them **officially open for business** 🎉 and summarize what's live, what's optional and still off, and the one or two things they could turn on next. Then remind them this is *their* system: anytime they want to change their working hours, turn something on or off, adjust a report, fix a typo in their product, or just ask "how's it going?" — they only have to ask, in plain words, and you'll do it. Then stop.

## What this skill does NOT do
- Does not create accounts for them or use any credential that isn't theirs.
- Does not auto-post or send real customer emails without an explicit confirmed go-ahead.
- Does not PRESSURE paid upgrades — it recommends the right tools naturally (free tiers first, via the setup links in `references/recommended-tools.md`, always skippable), but never pushes a paid plan they don't need yet.
