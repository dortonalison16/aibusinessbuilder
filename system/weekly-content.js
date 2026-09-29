// The weekly content chain as ONE scheduled job:  research -> write -> render images -> render reels.
//
//   node system/weekly-content.js
//   node system/schedule-automation.js add --name content-week --script weekly-content.js --freq weekly --day Mon --offset 15
//
// Why one job instead of four: scheduled separately they all started at the same minute, so the
// renderers ran against LAST week's plan while the writer was still working. Here each step
// finishes before the next begins, and a failed step never blocks the ones that don't depend on it
// (no research this week? the writer still writes from the brand profile).
//
// Posting stays a separate daily job (social-post.js) — it posts each item on its own date.

const { weeklyGuardOrExit, markRan } = require('./lib/working-hours');
const { sendTelegram } = require('./lib/telegram');

// A step fails when it throws OR leaves process.exitCode at 1 — the renderers set that when any item
// failed, even if others rendered, so a half-rendered week is never reported (or marked) as done.
async function step(label, fn) {
  const t = Date.now();
  console.log(`\n── ${label} ──`);
  try { const value = await fn(); return { label, ok: process.exitCode !== 1, secs: Math.round((Date.now() - t) / 1000), value }; }
  catch (e) { console.log(`${label} hit an error: ${e.message}`); return { label, ok: false, error: e.message }; }
  finally { process.exitCode = 0; }
}

async function run() {
  weeklyGuardOrExit('content-week');
  // The steps run in this same process (require, not a child), so they all see this. The chain was
  // checked against working hours just above; a step that starts after closing time because the
  // research or a render ran long must not skip itself (lib/working-hours guardOrExit).
  const prevChain = process.env.AIB_IN_CHAIN;
  process.env.AIB_IN_CHAIN = '1';
  try { await chain(); }
  finally { if (prevChain === undefined) delete process.env.AIB_IN_CHAIN; else process.env.AIB_IN_CHAIN = prevChain; }
}

async function chain() {
  const results = [];
  // A scheduled catch-up after a failed render finds this week's plan already written (see
  // auto-content alreadyWroteThisWeek): the writer keeps it, so fresh research would be paid for
  // and never used. Only the render steps are re-run — and they only pick up items that aren't
  // rendered yet (status "planned"), so what rendered fine the first time is left alone.
  let written = false;
  try { written = require('./auto-content').alreadyWroteThisWeek(); } catch (_) { /* decide in the writer */ }
  if (written) console.log('\n── Research ──\nSkipped — this week\'s plan is already written, so this run only re-renders it.');
  else results.push(await step('Research', () => require('./content-research').run()));
  const write = await step('Write the week', () => require('./auto-content').run());
  results.push(write);
  results.push(await step('Render images', () => require('./render-content').run()));
  results.push(await step('Render reels', () => require('./render-reels').run()));

  // Say what really happened: "written and rendered" only when everything was written this run.
  const skipped = write.ok && write.value && write.value.skipped;
  // One writing batch can come back empty while the other is fine (the week is then part-written).
  // A catch-up run keeps the plan, so it reads the reminder the writer saved and repeats it.
  let missing = (write.ok && write.value && Array.isArray(write.value.missing)) ? write.value.missing : [];
  let words = (k) => k; let fix = () => '';
  try {
    const ac = require('./auto-content');
    words = ac.batchWords; fix = ac.missingFix;
    if (skipped === 'already-written') missing = ac.readMissing();
  } catch (_) {}
  const MISSING = missing.length
    ? `The ${missing.map(words).join(' and the ')} batch didn't come through — ${fix(missing)}.`
    : '';
  const bad = results.filter((r) => !r.ok);
  const NO_KEY = 'Nothing was written automatically this week — the AI writing key isn\'t connected. Ask your assistant to write the week with you (it still renders and posts).';
  let msg;
  if (bad.length) {
    msg = `🗓️ This week's content: ${results.length - bad.length} of ${results.length} steps done. Needs a look: ${bad.map((b) => b.label).join(', ')}. Ask your assistant "is it working?" for details.`;
    if (skipped === 'no-key') msg += `\n${NO_KEY}`;
    if (MISSING) msg += `\n${MISSING}`;
  } else if (skipped === 'no-key') msg = `🗓️ ${NO_KEY}`;
  else if (skipped === 'already-written') msg = `🗓️ This week's content was already written, so this run only re-rendered it — everything is rendered now. Posts go out on their own dates — open your assistant anytime to review or change them.${MISSING ? `\n${MISSING}` : ''}`;
  else if (MISSING) msg = `🗓️ Part of this week's content is written and rendered. ${MISSING} What's there goes out on its own dates.`;
  else msg = '🗓️ This week\'s content is written and rendered. Posts go out on their own dates — open your assistant anytime to review or change them.';
  console.log('\n' + msg);
  await sendTelegram(msg);
  // A week with a failed step is NOT marked done, so a scheduled catch-up run on the next working
  // day tries again (Claude busy, no internet) instead of losing the week. A week with no writing
  // key IS marked done: a retry can't conjure a key, and the owner would get the same text daily.
  // A week with one writing batch missing IS marked done too: a catch-up would find the plan
  // already written and skip the writer, so it could never fill the gap — the message above tells
  // the owner the one line that does ("write this week's reels").
  if (bad.length) process.exitCode = 1;
  else markRan('content-week');
}

module.exports = { run };

if (require.main === module) {
  run().catch((e) => { console.log(`Weekly content error: ${e.message}`); process.exitCode = 1; });
}
