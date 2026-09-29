---
name: health-check
description: This skill should be used when the user wants to know whether their automated business is set up and running — says "is it working", "is everything connected", "health check", "check my setup", "is my automation on", "did it post", "are my sales going through", "what's running", "something feels off", or asks why a sale/post/email didn't happen. It runs a plain-English check of every connection, the scheduled jobs, and any undelivered sales, then explains what's good and fixes what isn't. (Automated / Claude Code version.)
version: 0.1.0
---

# Is It Working? — The Health Check

A non-technical seller's biggest fear with an automated system is the **quiet failure** — thinking
sales are being delivered when they're not. This skill answers one question warmly and clearly:
**"Is everything actually working?"** — and offers to fix anything that isn't.

> **This is an Automated-version skill.** It checks the runtime in `system/`. If `client-config.md`
> says the mode is **on-demand/Desktop**, there's no runtime to check — say so kindly: *"This check
> is for the automated version. In the simple version there's nothing running in the background to
> check — you're in control of each step yourself."* Then offer the dashboard (`business-dashboard`) instead.

## How to run it

Run the check for them (they never type anything):

```
node system/health-check.js
```

It prints a friendly ✅ / ⚠️ / ⬜ list covering: the one-time tools install, payments (Stripe),
product delivery (email), phone alerts (Telegram), social posting, unattended AI writing,
scheduled automations, whether any **paid sales haven't been delivered yet**, and their working
hours. Add `--notify` to also text the report to their phone.

**Read the output and translate it into plain, calm language.** Never paste the raw list and walk
away — tell them what it *means* and what (if anything) to do.

- ✅ = working. Reassure them.
- ⬜ = not set up yet (often optional). Mention it's optional, or offer to set it up.
- ⚠️ = needs attention. This is the important one — explain it simply and offer to fix it now.

## Fixing the common ⚠️ items (offer, don't lecture)

- **"Email engine not installed" / "render engine not installed"** → the one-time setup didn't
  finish. Offer to run it: `npm install` in the `system/` folder (it takes a few minutes and needs
  internet). Then re-run the check.
- **"Payments — key set but Stripe rejected it"** → the Stripe key is wrong or was rotated. Walk
  them back through the payments step in `setup-connections`.
- **"Product delivery connected, but engine not installed"** → same `npm install` fix as above.
- **"X paid sale(s) not delivered yet"** → run the sale check now so those buyers get their product
  immediately: `node system/check-sales.js`. Then reassure them it's caught up.
- **"Stripe in TEST mode"** → they're using test keys, so no real money moves. If they're ready for
  real sales, route to `setup-connections` to swap in their live keys.
- **"It looks like this folder moved"** → moving or renaming the business folder breaks the scheduled
  jobs (they still point at the old location). One command rebuilds them here: run
  `node system/schedule-automation.js reregister`, then re-run the check. Reassure them nothing was
  lost — it just needed re-pointing.

## When everything's green
Celebrate it simply: *"Everything essential is connected and running. When someone buys, they'll
get their product automatically and you'll get a text — even while you sleep."* Then point them to
`business-dashboard` ("How am I doing?") to see their actual numbers.

## Good habit to offer
Suggest running this check **after any setup change**, and any time something *feels* off. Offer to
schedule a weekly check that texts them the all-clear (or flags issues) via Telegram — route to
`setup-connections` to schedule `health-check.js --notify` inside their working hours.

## What this skill does NOT do
- It never changes a setting, key, or schedule on its own — it only *checks* and then offers fixes
  you run with their OK.
- It can't see whether their computer was *off* when a job was due (that's outside what any script
  can detect) — so if something was missed, gently remind them jobs only run while the computer is on.
