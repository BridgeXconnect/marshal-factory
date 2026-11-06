import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";

const { db } = await import("../db/client");
const { events, jobs, runs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { hosts } = await import("../lib/host");
const { github } = await import("../lib/github/pulls");
const { activePause, parseUsageLimit, RESUME_AFTER_RESET_MS, resumeDue, resumedAt } = await import("../lib/usage-limit");
const { ingestClient, threads, watchdog } = await import("../runner/ops");
const { inferUntracked } = await import("../runner/untracked");
const { pauseForLimit } = await import("../runner/usage-limit");
type ThreadRead = Awaited<ReturnType<typeof threads.read>>;

const stamp = Date.now() % 1_000_000;
const key = (name: string) => `UL${name}-${stamp}`;
const keys: string[] = [];
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const hourAgo = new Date(Date.now() - 3_600_000);
const inAnHour = new Date(Date.now() + 3_600_000);
const of = (actions: unknown, k: string) => (Array.isArray(actions) ? actions.filter((a: string) => a.startsWith(`${k}:`)) : actions);

async function insert(name: string, over: Partial<typeof jobs.$inferInsert>) {
  const k = key(name);
  keys.push(k);
  await db.insert(jobs).values(
    linearJob(`usage-limit-regress-${k}`, k, { machine_id: TEST_MACHINE_ID, stage: "implementing", t3_thread_id: `thread-${k}`, stage_at: hourAgo, updated_at: hourAgo, ...over }),
  );
  return k;
}

ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);
github.pullRequestForBranch = async () => null;
const shown = new Map<string, ThreadRead>();
const read: string[] = [];
threads.read = async (threadId) => (read.push(threadId!), shown.get(threadId!) ?? { state: "running", status: "running", lastMessage: null, limitedUntil: null });
const sent: { threadId: string; message: string }[] = [];
let sendFails = new Set<string>();
threads.send = async (threadId, message) => {
  if (sendFails.has(threadId)) throw new Error("t3 is down");
  sent.push({ threadId, message });
};
hosts.wake = async (job) => {
  throw new Error(`woke ${job.key}`);
};
const limited = (until: Date): ThreadRead => ({ state: "stopped", status: "failed", lastMessage: "You've hit your usage limit.", limitedUntil: until });
const settled: ThreadRead = { state: "stopped", status: "failed", lastMessage: "You've hit your usage limit.", limitedUntil: null };

try {
  // The pure helpers: a pause belongs to one attempt, and is due a minute after the reset.
  const pause = { attempt: 1, until: inAnHour.toISOString(), since: hourAgo.toISOString(), resumedAt: null };
  assert.deepEqual(activePause({ attempt: 1, usage_limit: pause }), pause);
  assert.equal(activePause({ attempt: 2, usage_limit: pause }), null, "an earlier attempt's pause is not this one's");
  assert.equal(activePause({ attempt: 1, usage_limit: { ...pause, resumedAt: hourAgo.toISOString() } }), null, "a resumed pause is over");
  assert.equal(activePause({ attempt: 1, usage_limit: { until: "soon" } }), null, "a malformed value is no pause");
  assert.equal(parseUsageLimit(null), null);
  assert.equal(resumedAt({ attempt: 1, usage_limit: { ...pause, resumedAt: hourAgo.toISOString() } })?.getTime(), hourAgo.getTime());
  assert.equal(resumeDue(pause, new Date(inAnHour.getTime() + RESUME_AFTER_RESET_MS - 1)), false);
  assert.equal(resumeDue(pause, new Date(inAnHour.getTime() + RESUME_AFTER_RESET_MS)), true);

  // Watchdog: a tracked thread that failed on its usage limit pauses instead of being nudged or failed.
  const CLAUDE = await insert("CLAUDE", { provider: "claudeAgent", nudged_at: hourAgo, nudged_stage: "implementing" });
  shown.set(`thread-${CLAUDE}`, limited(inAnHour));
  assert.deepEqual(of(await watchdog(), CLAUDE), [`${CLAUDE}:usage-limit-paused`]);
  const paused = await row(CLAUDE);
  assert.equal(paused.stage, "implementing", "the job is not failed");
  assert.deepEqual([paused.usage_limit?.attempt, paused.usage_limit?.until, paused.usage_limit?.resumedAt], [paused.attempt, inAnHour.toISOString(), null]);
  assert.deepEqual([paused.nudged_at, paused.nudged_stage], [null, null], "a nudge in flight is cleared");
  assert.ok(!sent.some((s) => s.threadId === `thread-${CLAUDE}`), "and no nudge is sent");

  // While the pause lasts the watchdog leaves the job alone, without even reading its thread.
  read.length = 0;
  assert.deepEqual(of(await watchdog(), CLAUDE), []);
  assert.ok(!read.includes(`thread-${CLAUDE}`), "a paused thread is not read");
  assert.equal((await row(CLAUDE)).stage, "implementing");

  // Untracked pass: a Codex thread that failed on its limit pauses instead of failing the job.
  const CODEX = await insert("CODEX", { provider: "codex" });
  shown.set(`thread-${CODEX}`, limited(inAnHour));
  const inferred = await inferUntracked({ only: [CODEX] });
  assert.deepEqual(inferred, [`${CODEX}:usage-limit-paused`], JSON.stringify(inferred));
  const codex = await row(CODEX);
  assert.deepEqual([codex.stage, codex.usage_limit?.until], ["implementing", inAnHour.toISOString()]);
  assert.deepEqual(await inferUntracked({ only: [CODEX] }), [], "a paused job is skipped by the next pass");

  // A pause whose stage moved on since the pass read it is not recorded.
  const MOVED = await insert("MOVED", { provider: "codex" });
  assert.equal(await pauseForLimit({ ...(await row(MOVED)), stage: "triage" }, inAnHour), false);
  assert.equal((await row(MOVED)).usage_limit, null);

  // Resume: once the limit has reset, the watchdog tells the thread to go on, once.
  const resetAgo = new Date(Date.now() - RESUME_AFTER_RESET_MS - 60_000);
  await db.update(jobs).set({ usage_limit: { ...paused.usage_limit!, until: resetAgo.toISOString() } }).where(eq(jobs.key, CLAUDE));
  shown.set(`thread-${CLAUDE}`, settled);
  assert.deepEqual(of(await watchdog(), CLAUDE), [`${CLAUDE}:usage-limit-resumed`]);
  const resumes = sent.filter((s) => s.threadId === `thread-${CLAUDE}`);
  assert.equal(resumes.length, 1);
  assert.match(resumes[0]!.message, new RegExp(`usage limit that paused factory run ${CLAUDE} has reset`));
  assert.match(resumes[0]!.message, /Call report_stage/);
  const resumed = await row(CLAUDE);
  assert.ok(resumed.usage_limit?.resumedAt, "the pause is marked resumed");
  assert.equal(activePause(resumed), null);

  // The resumed thread's quiet counts from the resume, so it is not nudged or failed straight away.
  assert.deepEqual(of(await watchdog(), CLAUDE), []);
  assert.equal(sent.filter((s) => s.threadId === `thread-${CLAUDE}`).length, 1, "no nudge follows the resume");
  assert.equal((await row(CLAUDE)).stage, "implementing");

  // A thread T3's own auto-resume already continued gets no second message.
  const T3RESUMED = await insert("T3RESUMED", { provider: "claudeAgent" });
  await db.update(jobs).set({ usage_limit: { ...paused.usage_limit!, until: resetAgo.toISOString() } }).where(eq(jobs.key, T3RESUMED));
  shown.set(`thread-${T3RESUMED}`, { state: "running", status: "running", lastMessage: null, limitedUntil: null });
  assert.deepEqual(of(await watchdog(), T3RESUMED), [`${T3RESUMED}:usage-limit-resumed`]);
  assert.ok(!sent.some((s) => s.threadId === `thread-${T3RESUMED}`), "T3 already sent its own continue");
  assert.ok((await row(T3RESUMED)).usage_limit?.resumedAt);

  // A resume whose send fails gives the pause back, so the next pass tries again.
  await db.update(jobs).set({ usage_limit: { ...codex.usage_limit!, until: resetAgo.toISOString() } }).where(eq(jobs.key, CODEX));
  shown.set(`thread-${CODEX}`, settled);
  sendFails = new Set([`thread-${CODEX}`]);
  await assert.rejects(watchdog(), /t3 is down/);
  assert.equal((await row(CODEX)).usage_limit?.resumedAt, null, "the pause is still owed a resume");
  sendFails = new Set();
  assert.deepEqual(of(await watchdog(), CODEX), [`${CODEX}:usage-limit-resumed`]);
  assert.equal(sent.filter((s) => s.threadId === `thread-${CODEX}`).length, 1, "the retry sends the continue");

  // A thread that hit its limit again by the time the old one reset gets no message; the next pass pauses it again.
  const AGAIN = await insert("AGAIN", { provider: "claudeAgent" });
  await db.update(jobs).set({ usage_limit: { ...paused.usage_limit!, until: resetAgo.toISOString() } }).where(eq(jobs.key, AGAIN));
  shown.set(`thread-${AGAIN}`, limited(inAnHour));
  assert.deepEqual(of(await watchdog(), AGAIN), [`${AGAIN}:usage-limit-resumed`]);
  assert.ok(!sent.some((s) => s.threadId === `thread-${AGAIN}`));
  assert.deepEqual(of(await watchdog(), AGAIN), [`${AGAIN}:usage-limit-paused`]);

  console.log("usage-limit regressions passed");
} finally {
  if (keys.length > 0) {
    await db.delete(events).where(inArray(events.job_key, keys));
    await db.delete(runs).where(inArray(runs.job_key, keys));
  }
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "usage-limit-regress-")}%`));
  process.exit(process.exitCode ?? 0);
}
