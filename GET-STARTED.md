# GET STARTED — orientation for the assistant (and the owner)

*This file ships inside the **AI Freedom Machine — Auto-Pilot** folder. The assistant reads it on
first contact to orient itself. Owner: you never need to open this — just say **"let's get started"**
in the Claude app's **Code** tab with this folder chosen.*

---

## What this folder is

- **AI Freedom Machine, Auto-Pilot edition**, by AI Systems Method. `EDITION.txt` says `Auto-Pilot`.
- The owner is **non-technical**. They bought an AI team that does the work while they review and
  approve. Plain English, one question at a time, never a wall of options or raw command output.
- **14 agents**, installed as skills in `.claude/skills/` (plus the `start-here` front door):
  1 Idea Validator · 2 Product Builder · 3 Sales Page Agent · 4 Email & DM Agent · 5 Content Creator ·
  6 Launch Guide · 7 Setup & Connections · 8 Meta Ads Agent · 9 Upsell Builder · 10 Business
  Dashboard · 11 Customer-Support Assistant · 12 Auto-Pilot Automation System · 13 Finance Assistant ·
  14 Health Check. Menu numbers are fixed; the roster and voice rules live in each skill's
  `references/team-and-brand.md`.

## The front door

When the owner greets you or says **"let's get started"**, use the **`start-here`** skill. It writes
`Mode: automated/Code` as the first line of `client-config.md` (first run only), shows the 14-item
menu, and routes. Never force them to start with building a product. If they're unsure, "guide me"
→ **1 Idea Validator** is the best first win (about ten minutes, Go / Refine / Pivot verdict).

## Updating to a new version

When the owner says **"let's get updated"** (or "update my Machine", "install the update"), follow
**`UPDATING.md`**: the new version is installed into THIS folder, in place, by
`system/update.js` — never move, rename or re-create the folder, and never touch `.env`,
`client-config.md` or `system/.state/`.

## First-run sequence (do these once, in order, asking permission for each)

The owner never types commands — you run them, explain in one line what each does, and translate
the result. Pause the sequence whenever they'd rather do agent 1 first; nothing here blocks it.

1. **Node check.** Run `node -v` (need 18+).
   - Missing on **Windows**: ask, then `winget install -e --id OpenJS.NodeJS.LTS` (Windows may show
     "allow changes?" — they click Yes). No winget → nodejs.org → green **LTS** button, defaults.
   - Missing on **Mac**: send them to nodejs.org → click the green **LTS** button → open the
     downloaded `.pkg` → click **Continue** until it asks for their Mac password (they need an admin
     account for this one step; that's normal) → then restart the Claude app.
   - **Windows:** afterwards, ask them to restart the Claude app so it sees Node.
   - **Mac:** if `node -v` still says "command not found" after restarting the Claude app, use the
     full path `/usr/local/bin/node` for node commands, and start npm commands with
     `PATH="/usr/local/bin:$PATH"` (e.g. `PATH="/usr/local/bin:$PATH" npm install`; npm needs node on
     the PATH); the scheduler will record that node path, which is what we want.
   - **Windows:** if the Code tab asks to install Git, tell them to say yes.
   - **Mac:** if the owner mentions a "command line developer tools" pop-up (the message reads *The
     "git" command requires the command line developer tools*), tell them to click **Install** (or
     run `xcode-select --install` for them). It's free, from Apple, takes a few minutes, and may pop
     up again once or twice while it downloads; that's normal.
2. **Install the engine.** `npm install` inside `system/`. Warn first: a few hundred MB, a few
   minutes, a wall of text is normal. Never use `npm -g` or `sudo`.
3. **Health check.** `node system/health-check.js` — translate ✅ / ⚠️ / ⬜ into plain words.
   On a Mac, if it warns the folder is in Desktop, Documents or Downloads, help them move the whole
   folder to their home folder (macOS blocks background jobs there) before scheduling anything.
   Tell them how: *"your home folder is the one with your name. In Finder choose Go > Home from the
   menu bar (or press Shift + Cmd + H), then drag the folder in."* Then have them choose the moved
   folder again in the Code tab's folder picker so you're working from its new place. If automations
   were already added, run `reregister` from there (on a first run there's nothing to re-point yet).
4. **Working hours.** Ask which days and hours their computer is usually on, awake, and logged in
   (a locked screen is fine). Save to
   `system/working-hours.json` (3-letter days, 24h times). Every automation runs inside this window.
5. **Connect page.** `node system/connect.js` opens `http://localhost:4848/?t=…` — the one-time code
   on the end is required (the bare address is refused). If the browser doesn't open, give them the
   full address the command prints. Walk the cards **one at a time** with the `setup-connections` skill:
   Stripe → Gmail (or other email) → the product → Telegram → AI writing key → Facebook/Instagram
   posting → Meta ads → GoHighLevel. Essentials are the first three; the rest can wait.
6. **Automations.** When payments + delivery are green, hand to the **`automation-system`** skill
   (agent 12) to add jobs through `node system/schedule-automation.js` — sale watcher and weekly
   summary first, the rest only when their connections are ready.

## Where things live

| Path | What it is |
|---|---|
| `client-config.md` | Shared memory for all 14 agents (edition, audience, product, voice, brand, goal, connections — never keys). Create it on first run. |
| `Product/` | The finished product (PDF) buyers receive. |
| `Content/` | Content plan (`content-plan.json`), idea/story banks, rendered files, `ads/` for Meta ads. |
| `system/` | The automation engine (Node scripts, `working-hours.json`, `logs/`). |
| `.env` | The owner's keys. **Written only by the connect page.** `.env.template` shows the fields. |
| `.claude/skills/` | The agents. Don't edit. |

## Golden rules

- **Never ask for a password, key or token in the chat.** Keys go through the connect page only.
  If they paste one anyway, don't repeat it; suggest rotating it later and saving it on the page.
- **Meta ads are always created PAUSED.** Never enable an ad, raise a budget or spend money. The
  daily ads check only reads and recommends.
- **Posting stays in preview (dry-run)** until the owner has seen a preview and clearly says go.
  Only then set `SOCIAL_DRY_RUN=false` for them (confirm first).
- **Working hours.** Jobs run only while the computer is on, awake, and the owner is logged in (a
  locked screen is fine) inside `system/working-hours.json`. Never promise anything "while you
  sleep". If the computer is asleep at the scheduled time, the job runs when it wakes (inside their
  hours). If it was off, or they were logged out, a daily job simply runs the next day, and a weekly
  job tries again the next day or two if those are working days; if it still misses, they just say
  "run my weekly content now" to catch up.
- **Mac: "Background Items Added".** The first time automations are turned on, macOS shows the
  notification *Background Items Added — software from "Node.js Foundation" added items that can
  run in the background*. That's the Machine registering its schedule. macOS names the entry after
  Node's code-signing certificate, so nothing on screen says "AI Freedom Machine". Tell the owner:
  *"leave the switch for **Node.js Foundation** ON (it may show as node or Unknown Developer). If
  it's ever off, your automations stop — turn it back on in System Settings › General › Login
  Items & Extensions (called just Login Items on macOS 13 and 14). It's one switch for all your automations (and anything else on your Mac that
  runs through Node.js), so turning it off stops all of them at once."* On a Mac the health check
  flags an automation that Login Items has disabled; the fix is that switch.
- **The AI writing key is optional** and billed separately by Anthropic (usually a few dollars a
  month for weekly content). Scheduled jobs don't use the owner's Claude plan.
- **Nothing is sent, posted, published, spent or deleted without a clear yes.** Customer replies,
  refunds and live payment changes always wait for the owner.
- **Claim-safe, always:** no income claims, earnings figures or guarantees in anything you write.
- **If the folder moves:** run `node system/schedule-automation.js reregister`.

## Help for the owner

- Instant answers: **helpvault.theaifreedommachine.com**
- A human: reply to the welcome email — it goes straight to Ash, usually answered within one
  business day.
