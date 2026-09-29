# Campaign Playbook — Setting Up Ads That Can Actually Learn

*Read before building anything in an ad account (Ads Kit or Auto-Pilot). These are the setup decisions that quietly decide whether ad spend teaches Meta anything.*

## Before anything: the two things that silently break ads

**1. The pixel must fire the event you optimize for.**

Most funnel builders (GoHighLevel included) fire only `PageView` — not `Lead`,
`CompleteRegistration`, or `Purchase`. An ad set optimizing for an event that never fires
**cannot learn, but still spends** — Meta just shows the ad to whoever is cheapest to reach, and
the leads are worthless.

The fix needs no code: a **Custom Conversion** built on the thank-you page URL. Walk them
through it in Events Manager, then save its ID in the connect page (Meta ads card → Custom Conversion ID). **Do not launch a campaign whose optimization
event has never fired and has no custom conversion.** Check first, every time.

⚠️ Two traps when writing those URL rules, both of which quietly corrupt everything downstream:
- A **registration** confirmation is not the same page as a **purchase** thank-you. Check which
  step actually follows the opt-in — using the wrong one teaches Meta to optimize for the wrong
  thing entirely.
- **Watch for substrings.** If the purchase page is `/thank-you` and the opt-in page is
  `/thank-you-free`, a "contains /thank-you" rule counts every free opt-in as a sale. Their ROAS
  will look wonderful and be fiction. Exclude explicitly.

**2. Currency.** If the ad account currency differs from the product's pricing currency, values
get booked in the *account's* currency and every campaign looks less profitable than it is.
Check both and set the conversion value in account currency.

## Exclude existing customers — the easy money

Build a customer-list Custom Audience from their buyer emails (hashed — never raw), and set it
as an **exclusion** on every ad set. They should never pay to advertise a product to someone who
already bought it. Refresh it as sales come in, and mention it as an upsell audience later.

How: Ads Manager → **Audiences** → **Create audience** → **Custom audience** → **Customer list** →
upload a CSV of buyer emails exported from Stripe or their CRM (Meta hashes it on upload). Then make
every new ad set exclude it: with their OK, add `"excludeAudienceIds": ["<the audience id>"]` to
`system/ads-state.json` (you edit it for them). For an ad set that already exists, add the exclusion
in Ads Manager → the ad set → **Audience** → **Exclude**.

## Campaign structure — get this right once

**One durable campaign per objective. Create it once. Add fresh creative to the same ad set
forever.**

This is the single most expensive mistake in paid social: making a new campaign every week.
Optimization history lives on the **ad set** — a new campaign throws it away and puts you back
in learning phase permanently. New creatives go in as **PAUSED ads inside the existing ad set**.

**What to optimize for depends on price, and this is arithmetic, not opinion.** Learning phase
needs roughly **50 conversions per ad set per week**. So:

- **A cheap or free lead event** (guide, workshop, waitlist) hits that easily on a small budget.
  Start here almost always.
- **A purchase event on a higher-priced product** needs 50 × their target cost-per-sale per
  week. On a $200 product with a $70 target, that's ~$500/day. If they can't sustain that,
  a cold purchase-optimized campaign **will not work** — and you should say so plainly rather
  than let them burn a month finding out.

So the default structure that works on a real budget (the Ads Kit / engine builds the first one;
the owner builds the second in Ads Manager, with your step-by-step guidance):

| Campaign | Audience | Carries |
|---|---|---|
| Lead-gen | cold, broad | the free thing |
| Retargeting | warm — site visitors, video viewers, page engagers | the sales ask |

Retargeting is where higher-priced purchases actually convert, and small warm audiences don't
need to exit learning phase. **Start retargeting a week or two in** — there's nobody to retarget
until the cold campaign has driven traffic. `meta-ads.js setup` only builds the cold lead campaign
(`OUTCOME_LEADS`, optimized for Lead or the one `META_CUSTOM_CONVERSION_ID`), so walk the owner
through creating the retargeting (or any purchase-optimized) campaign in Ads Manager themselves.

**Building the retargeting campaign in Ads Manager (walk them through it, one step at a time):**
1. **Audiences** (Ads Manager menu → Audiences) → **Create audience → Custom audience → Website** →
   their pixel → **All website visitors** → **30 days** → name it "Site visitors 30d" → **Create**.
2. Back in Ads Manager → **+ Create** → **Sales** → turn **OFF** the **Advantage+ sales campaign**
   toggle (older screens: choose **Manual**) → name it "Retargeting". In the ad set, set the conversion event to **Purchase**.
3. In the ad set → **Audience** → switch to the **original audience options** (Advantage+ audience
   off), so the custom audience is a hard limit rather than a suggestion → choose **Site visitors
   30d** as the custom audience; keep the same
   countries as the cold campaign.
4. Still in Audience → **Exclude** → their buyers (a custom audience of people who reached the
   thank-you page, or a customer list) so buyers don't keep seeing the sales ask.
5. Add the ads, then keep it **PAUSED**: don't click **Publish** yet — close the editor and it
   stays saved as a draft, which spends nothing. Review it together first; they publish it and
   switch it on themselves.

## Targeting — broad, but not careless

Stay **broad. Don't stack interests** — on a new pixel, interest targeting mostly just shrinks
the pool, and Meta's delivery is better at finding buyers from the conversion signal than
hand-picked interests are. Control quality with these instead:

- **Geo:** the countries where they can actually be paid and where the price makes sense. Adding
  cheap-CPM countries to chase a lower cost-per-lead is a trap — those leads rarely convert, and
  worse, Meta *learns* from them and steers the whole ad set toward more of the same.
- **Age:** trim the bottom end. The youngest bracket in most markets clicks cheaply and buys
  rarely, dragging cost-per-lead down and quality with it.
- **Advantage+ audience expansion OFF.** This is the big one. Broad targeting is good; *expansion*
  lets Meta wander outside the targeting entirely to find cheaper people. It's the main source of
  "why is every lead junk." Turn it on only once an ad set is proven and profitable.
- **Exclude Audience Network.** Third-party apps and games where most "clicks" are accidental
  taps. Keep Facebook and Instagram feeds, stories, and reels.
- **Language:** target their language explicitly — it filters non-speakers inside target
  countries and catches speakers outside them (set it in Ads Manager → ad set → Audience →
  Languages; the engine leaves it open).

Keep any two campaigns you're comparing **identically targeted**. If the audiences differ, the
test tells you nothing.

## UTM tracking — the thing that answers the real question

Stamp every creative with source, medium, campaign, ad name, **and the campaign/ad-set/ad IDs**.
Names are readable; IDs are the reliable join key because names can be edited later.

This matters more than it sounds. Meta's own reporting stops at the click. UTMs captured on the
contact record let them answer the question that actually decides scaling: not *"which ad got
cheap leads"* but **"which ad got leads that eventually bought."** That number — value per lead
over 30–60 days — is what tells them how much they can afford to spend. Everything else is guessing.
