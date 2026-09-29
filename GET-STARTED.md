# How to Get Started — Your Step-by-Step Guide 💛

Welcome! This guide gets your AI business assistant up and running. It looks like a lot, but
each step is just "click this, then that." Take it slow. You've got this.

> **You do NOT need to be techy.** And once your assistant is running, you can ask *it* for
> help with anything — in plain words, anytime.

---

## First: pick your version (30 seconds)

This system comes in **two versions that do the same things**. Pick the one that fits you:

| | **✨ Easy Version (Desktop app)** | **⚙️ Automated Version (Claude Code)** |
|---|---|---|
| **Best for** | Most people. Simplest setup. | People who want it to run on its own. |
| **How it works** | You ask, it creates — product, emails, content (carousels, reels, stories, posts), sales page — on the spot. | Same, PLUS it runs jobs on a schedule: writes & renders your weekly content, posts it for you (you preview first), auto-delivers every sale, and texts you each order. |
| **Setup** | Download an app, sign in, add the skills. No "tech." | A bit more: install a free engine + the assistant. |
| **Automations run by themselves?** | No — you ask whenever you want something. | Yes — while your computer is on. |

**Not sure?** Start with the **Easy Version**. You can move up to the Automated Version later
without losing anything — your answers are saved.

- 👉 **Easy Version:** follow **Track A** below.
- 👉 **Automated Version:** follow **Track B** below.

---

# Track A — Easy Version (Claude Desktop app)

### Step A1 — Create your Claude account
1. Go to **https://claude.ai** in your web browser.
2. Click **Sign up** and create an account (email or Google).
3. The Co-Pilot experience runs on Claude's **Cowork** feature, which needs a paid plan —
   **Claude Pro** is plenty to start. Click **Upgrade** and choose Pro.
   *(This is your subscription to the AI itself — it's what powers your assistant.)*

### Step A2 — Download the Claude desktop app
1. Go to **https://claude.ai/download**.
2. Click the button for your computer (**Windows** or **Mac**).
3. Open the downloaded file and install it (click through **Next/Continue → Install**).
4. Open the **Claude** app and **sign in** with the account from Step A1.

### Step A3 — Add your assistant's skills
Your product came with a **`Skills` folder** containing several `.zip` files (one per skill).
Add each one:
1. In the Claude app, click **Customize** in the **left sidebar**, then open the **Skills** tab.
   (Customize groups Skills, Plugins, and Connectors in one place.)
2. Click the **➕**, then **Create skill**, then **Upload a skill**.
3. **Choose one of the `.zip` files** from your `Skills` folder. *(Pick the `.zip` itself — don't
   unzip it first.)*
4. Repeat for each `.zip` — add them all, starting with `start-here`.

✅ You'll know it worked when you can type **`/`** in the message box and see them listed
(like `/start-here`). You should end up with all your skills showing — if you're missing one,
you skipped a `.zip`; just add it.

> **Not showing up when you type `/`?** Two usual causes: (1) you uploaded the *unzipped folder*
> instead of the `.zip` file — re-add the `.zip` itself; or (2) you didn't finish the **Create
> skill** step. Make sure you're signed in, then close and reopen the app and check again.
> **Don't see a "Customize" button at all?** Your app may need updating — reinstall from
> **https://claude.ai/download** and reopen.

### Step A4 — (Recommended) Let it save your work in a folder
This is optional but makes things smoother — it lets your assistant **save** your product,
emails, and content as real files so nothing gets lost:
1. Move your **business folder** (the one from your download) to your **Desktop**.
2. In the Claude app, look for **Open folder** (or the folder icon) and choose that folder.

**Don't have that option, or want to skip it?** Totally fine. Your assistant will just keep
everything **in the chat** and give you a **"Business Profile"** to save — paste it back when
you return and it remembers everything.

> 💡 **Tip to never lose your progress:** create a **Project** in Claude (left sidebar →
> Projects → New), and paste your Business Profile into the Project's instructions. Then every
> new chat in that Project already knows your business. Your assistant will offer to set this up.

### Step A5 — Say hello 👋
In the message box, type:
```
let's get started
```
Your assistant welcomes you and shows you a menu — **build your product, make content, write
emails, build your sales page**, or just be guided. Pick whatever you want first.

➡️ **Skip to "You're in — what now?" at the bottom.**

---

# Track B — Automated Version (Claude Code)

This version can run things on a schedule. It needs two free installs first.

### Step B1 — Create your Claude account
Same as Step A1 above (go to https://claude.ai, sign up, choose a paid plan).

### Step B2 — Open your computer's command window
This is a plain text window. It's not scary — you just type into it.
- **Windows:** click **Start**, type **PowerShell**, click **Windows PowerShell**.
- **Mac:** press **⌘ + Spacebar**, type **Terminal**, press **Enter**.

### Step B3 — Install the free engine (Node.js)
1. Go to **https://nodejs.org** and click the green **LTS** button.
2. Open the download and click through **Next/Continue → Install** (accept defaults).
3. **Close and reopen** the window from Step B2.
4. Check it: type `node --version` and press Enter. If you see `v22.x.x` (or similar), 🎉.

### Step B4 — Install your assistant (Claude Code)
In the same window, paste this and press Enter:
```
npm install -g @anthropic-ai/claude-code
```
Let it finish (a minute of scrolling text is normal).

### Step B5 — Open your assistant inside your business folder
1. Move your **business folder** to your **Desktop**.
2. In the window, type `cd ` (with a space), then **drag your business folder onto the window** —
   it pastes the folder's location. Press Enter.
   > *If dragging pastes nothing (this can happen on Windows PowerShell): open the folder, copy its
   > path from the address bar at the top, then type `cd "` and paste, and add a closing `"`. The
   > quotes matter if the path has spaces — e.g. `cd "C:\Users\You\Desktop\AI Freedom Machine"`.*
3. Type:
```
claude
```
4. The first time, it'll ask you to **sign in** — follow the prompts.

### Step B6 — Say hello 👋
Type:
```
let's get started
```
The **first** time, your assistant sets up its tools for you (a one-time setup it runs itself —
it takes a few minutes and needs internet; a wall of scrolling text is normal). After that,
because this is the Automated Version, it can also **schedule things for you** — it'll ask what
hours your computer is usually on, so jobs only run when they'll actually work.

---

## You're in — what now?

Your assistant takes over from here. Just talk to it normally. You can:
- **Build your product**, **write your emails & DM scripts**, **build your sales page**
- **Make a week of content** — carousels, reels, stories, posts. *(Automated Version renders the finished images & reels and can post them; Easy Version writes everything + gives you the exact prompts to build them fast in Canva.)*
- **Run your Meta ads** — when you're ready for paid traffic, say *"set up my Meta ads for my product."* Your team writes the copy, creates the creative, **sets up the whole campaign in your ad account, then analyzes and optimizes it for you** — scaling what's working and switching off what isn't (the part most people find intimidating, handled). You set your budget and the rules; it works within them. *(Ads are optional — your content engine runs on $0. Add ads once your product and page are live.)*
- **Connect your accounts** (Automated Version) so it can take payments, auto-deliver every sale,
  text you each order, send a weekly summary, and **post your content on a schedule** (you preview first)
- **Manage your books** (Automated Version — exclusive) — your built-in **Finance Assistant** helps with
  bookkeeping, profit & loss, money & tax questions, and getting ready for your accountant, from a
  simple receipt tracker all the way to QuickBooks (review-first — it never changes your books without your OK)
- **Check everything's running** (Automated Version — exclusive) — say *"health check"* and your built-in **Health Check** confirms every connection, scheduled job, and delivery is working, then tells you in plain words if anything ever needs you
- Change your mind, ask questions, or tweak anything — *just say it in plain words*

> 💬 **You're always in control.** If you're unsure, stuck, or want something changed — type it
> however you'd say it out loud. Your assistant is there to do the hard parts for you.

---

## If you hit a usage limit ⏳

Your Claude plan includes plenty for everyday work, but big jobs — building a full product, or a
whole week of content in one sitting — use more of it. If Claude tells you you've reached your
limit, **nothing is lost.** You have options:

- **Just wait a bit.** Limits reset on a rolling basis (usually within a few hours). Come back and
  continue right where you left off.
- **Work in smaller bites.** Do one thing at a time — build your product first, then come back
  later for content — instead of asking for everything at once.
- **Save your progress.** Keep your **Business Profile** (or use a connected folder) so a brand-new
  chat instantly remembers your business when you return.
- **Know your plan options.** **Claude Pro** (~$20/mo) is the starting point and is plenty for most
  people. If you regularly hit limits or use it heavily, **Claude Max** steps up: the **5× tier**
  (~$100/mo) gives five times Pro's capacity, the **20× tier** (~$200/mo) gives twenty times. You can
  change tiers anytime in your Claude account and your work carries over *(check claude.ai for current
  pricing)*. **Any paid plan works — bigger plans don't add features, just more room** for back-to-back
  big jobs (and, in the Automated Version, heavier scheduled automation, which draws from the same pool).
  Start on Pro; only move up if you actually keep running out.

---

## If you get stuck
- **Easy Version:** make sure you added the skills (Step A3) and you're signed in. Type `/` to
  check they're there.
- **Automated Version:** the #1 mix-up is forgetting to **close and reopen** the window after
  installing Node (Step B3). Try that first. A few other quick ones:
  - **`node` or `npm` "not recognized"** → Node didn't finish installing, or the window wasn't
    reopened. Close and reopen it; if it's still not found, reinstall Node from
    **https://nodejs.org** and reopen once more.
  - **`npm install` failed** → make sure you're online. On **Mac**, if you see a "permission" or
    `EACCES` error, run the same line again with `sudo ` in front and enter your computer password.
  - **`claude` "not recognized" after installing it** → close and reopen the window one more time
    (it needs a fresh window to see the new command). If it still can't find it, re-run the install
    line from Step B4.
- Either way: once the assistant is running, just tell it what's happening — *"I'm stuck on
  step 3"* — and it'll help you through it. 💛
- Still stuck on anything? **Reply to your welcome email** with a screenshot — priority support
  will get you sorted.
