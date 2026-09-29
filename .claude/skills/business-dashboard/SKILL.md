---
name: business-dashboard
description: This skill should be used when the user wants a snapshot of how their business is doing — says "how am I doing", "my dashboard", "my numbers", "how's my business", "what should I do next", "business snapshot", "show my progress", "where am I at", "how many sales", "how's it going", or picks "How am I doing?" from the start-here menu. It turns the pile of tools into one plain-English picture — sales, revenue, content, goal, and connections — and always ends with a short, prioritized "what to do next."
version: 0.1.0
---

# Business Dashboard — Your "How Am I Doing?" Snapshot

This is the skill that makes someone *feel* like they have a business, not just a folder of tools. You gather what's known, show it back in warm plain English, and always end by pointing them at the single most useful next move. **No jargon, no numbers they have to decode, no walls of data.** A glance, a feeling of progress, and one clear next step.

## Golden rules

1. **Plain English only.** Never show raw JSON, code, file paths, Stripe IDs, or CLI. Translate everything into "You've made 3 sales this week — that's $87." 💛
2. **Read what's already known.** Pull from `client-config.md` and saved files before asking the user for anything. Don't make them repeat what the system already knows.
3. **One picture, then one next step.** Show the snapshot, then end with a short prioritized **What to do next** (1–3 actions, most important first). Never leave them wondering.
4. **Honest *and* encouraging.** If the numbers are zero, that's a beginning, not a failure — frame it as "you're at the starting line, here's the very next step," never as bad news.
5. **Be mode-aware.** How you *get* the numbers depends on whether they're on Auto-Pilot or Co-Pilot (below). The *picture you show* looks the same either way.
6. **Everything is skippable.** If they don't want to give a number, show the picture without it and note it gently.
7. **They can ask anytime.** Remind them they can say "how am I doing?" whenever they want, and change their goal or ask you to explain any part — in plain words.
8. **Render it right here in the chat — never a browser.** Show the snapshot as clean, premium, formatted markdown *in the conversation.* **Do NOT create an HTML file, open a browser window, or launch a new tab** for the dashboard. The entire value is a beautiful, at-a-glance snapshot that never makes them leave the chat. (If they ever explicitly ask for a shareable web/PDF version, offer it as a separate export — but the default answer is always the in-chat snapshot.)

## First: check the mode
Read the `Mode:` line in `client-config.md`.
- **Auto-Pilot (automated / Claude Code):** you can read the real local data the runtime already stores — no need to ask the user for numbers. See "Gathering data — Auto-Pilot."
- **Co-Pilot (on-demand / Claude Desktop):** there's no scheduled runtime keeping a running tally. Read any saved files in their business folder, and ask for a couple of numbers only if needed. See "Gathering data — Co-Pilot."
- If there's no `Mode:` line yet, assume Co-Pilot (ask, don't promise automation).

## Gathering data — Auto-Pilot (read real local data, touch nothing)
You can assemble the whole snapshot quietly from data the system already has. Do this *for* them — they never touch anything.

- **Sales + revenue:** the same way `check-sales.js` and `weekly-digest.js` do it — ask Stripe (read-only) for recent paid checkouts using the buyer's own key in `.env`.
  - **All time:** count paid checkout sessions and sum their amounts.
  - **This week:** the same, limited to the last 7 days.
  - If Stripe isn't connected yet (no key), don't error — just say "Payments aren't hooked up yet, so I can't count sales automatically. Want to connect Stripe so I can?" and point to `setup-connections`.
- **What content went out:** read `Content/content-plan.json` — how many items are planned, rendered, and posted, and the most recent few (in plain English: "3 posts and a carousel went out this week").
- **What's already handled (no double-counting):** the runtime remembers handled sales in its `.state` (e.g. `seen-sales`), the same store `check-sales.js` uses — lean on that rather than re-deriving anything.
- **Connection status at a glance:** check which credentials exist in `.env` (Stripe, email delivery, Telegram, social) and translate to plain words — "✅ Payments connected · ✅ Email delivery on · ⬜ Phone alerts off." Never print the keys themselves.
- **Working hours / automations:** glance at `system/working-hours.json` and which jobs are scheduled, so you can say "Your sale-watcher and weekly summary are running during your hours."

Gather silently, then show the picture. Narrate lightly if it takes a moment ("Checking your sales and what's gone out...").

## Gathering data — Co-Pilot (read files, or ask a couple of numbers)
No scheduler is keeping score here, so do the best honest picture you can:

- **First, read what's saved.** If a folder is connected, read `client-config.md` (product, price, goal) and any saved content the content skill produced — that alone tells you a lot ("Your product's built, your price is $39, and you've got a week of posts written").
- **Then ask only what's missing — gently, and skippably.** For sales, you can't see their Stripe, so ask one easy question: "Roughly how many sales have you made so far — and this week? (A ballpark is totally fine, or skip it.)" Use their number to fill in revenue (sales × their price from `client-config.md`).
- **If no folder is connected:** build the picture from what's in the conversation / their Business Profile, and ask for the couple of numbers you need. Still give them a real, useful snapshot.
- Never imply anything is being tracked automatically in this mode.

## The snapshot (render it beautifully, right here in the chat)
Show a clean, premium, scannable snapshot **as formatted markdown in the conversation** — never an HTML file or a browser window. Lead with the win. Use this shape (it renders crisply in both Claude Desktop and the Claude Code terminal):

> ## 📊 [Business name] — your snapshot
> *Live 13 days · a live read*
>
> | | This week | All time |
> |---|:--:|:--:|
> | 💰 **Sales** | **8** | **18** |
> | 💵 **Revenue** | **$232** | **$522** |
>
> 🎯 **Goal — $522 of your $1,000 first month**
> `████████████░░░░░░░░` **52%** · over halfway there 🎉
>
> 📱 **Content:** 5 posts + 1 reel went out this week · next week's is planned
> 🔌 **Connections:** ✅ Payments  ✅ Email delivery  ✅ Sale alerts  ✅ Ads *(small test running)*

**How to draw the goal bar:** a 20-character bar — filled blocks `█` for the percent complete, light blocks `░` for the rest (e.g. 52% ≈ 10 filled + 10 light), then the % and one warm line. Keep it to a tidy 20 chars so it never wraps.

Rules for the snapshot:
- Only show lines you actually have data for. Skip a line cleanly rather than showing "unknown."
- **Goal line:** read their goal from `client-config.md` if present (a `Goal:` line). If there's no goal yet, don't invent one — offer to set one: "Want to set a simple first goal, like 10 sales or $300 this month? It makes this feel real." Save it to `client-config.md` if they pick one.
- Translate connection status into ✅/⬜ plain words — never raw key names.
- If everything is zero, still show the frame, then reframe warmly (see below).

## When the numbers are zero (most common at the start)
Do **not** make them feel behind. Frame it as the very beginning of something real:

> You're right at the starting line — and that's exactly where every business begins. 💛
> Nothing's broken; there's just nothing to count *yet*. Here's the single next thing that
> moves you forward 👇

Then go straight to **What to do next** with the one action that unblocks them.

## What to do next (ALWAYS end with this)
End every snapshot with a short, prioritized list of **1–3 concrete next actions**, most important first, each pointing to the skill that does it. Pick based on where they actually are:

- **No product built yet** → "Build the thing you'll sell — it's the foundation for everything else." → `guided-setup`
- **Product built, but no sales page** → "Create the page that turns visitors into buyers." → `sales-page`
- **Product + page, but nothing's connected** → "Hook up payments and delivery so you can actually get paid." → `setup-connections`
- **Set up, but no content going out** → "Get a week of posts out to bring people in." → `content-creator`
- **Selling, but no follow-up emails** → "Add the emails that nurture and sell while you sleep." → `email-messaging`
- **Selling, but no upsell / second product** → "Add an upsell to earn more per buyer." → `guided-setup` (a second, higher-tier product)
- **Sales coming in and they want to understand the money** → "Get your books and profit in plain English." → `finance-agent` (Auto-Pilot)
- **Everything's humming** → celebrate, and suggest the next lever (more content, an ad, a price test).

Keep each next-action to one friendly line: *what* to do, *why* it helps, and *which* skill does it — phrased as an offer ("Want me to...?"), never a command. Cap it at 3 so it never feels like a to-do mountain.

## Setting / reading the goal
A goal makes the dashboard motivating instead of just informative.
- Look for a `Goal:` line in `client-config.md`. If present, show progress toward it on the 🎯 line.
- If absent, offer to set one once (don't nag): a simple sales count or dollar figure for the month. Save their pick under a `## Goal` section in `client-config.md` so every future snapshot shows progress.
- Frame progress as momentum, never as "you're behind."

## Mode reminders
- **Co-Pilot:** never imply sales are tracked automatically or that anything runs on a schedule. You're giving them a live read whenever they ask. If they wish it were automatic, name the Auto-Pilot version kindly — don't oversell.
- **Auto-Pilot:** you read real data they already have; reassure them you only *read* it (read-only) and change nothing. If a connection is missing, that's just a "want to set this up?" — point to `setup-connections`.

## Always
Close warm. Remind them this snapshot is here whenever they want it — they can just say "how am I doing?" — and that they can set or change a goal, or ask you to explain any number, in plain words anytime. 💛
