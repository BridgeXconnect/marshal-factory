import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, type JobRow } from "../db/schema";
import { ensureAwake, WakeDeferredError } from "../lib/host";
import { factoryPlaybook, jobExecution } from "../lib/playbook";
import { activePause, resumeDue, usageLimitResumeMessage, type UsageLimit } from "../lib/usage-limit";
import { threads } from "./threads";

// Usage-limit pauses on the runner's side; see lib/usage-limit.ts. A pause is recorded by whichever
// timer pass reads the thread first, and only the watchdog resumes one.

const log = (event: string, detail: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

type PausableJob = Pick<JobRow, "id" | "key" | "stage" | "attempt" | "usage_limit">;
type ResumableJob = PausableJob & Pick<JobRow, "t3_thread_id" | "execution" | "sandbox_id" | "sandbox_snapshot">;

/**
 * Records that the job's thread sleeps until its usage limit resets, unless the stage moved on
 * since the pass read it. A nudge in flight is cleared: the run is not stuck.
 */
export async function pauseForLimit(job: PausableJob, until: Date, now = new Date()) {
  const pause: UsageLimit = { attempt: job.attempt, until: until.toISOString(), since: now.toISOString(), resumedAt: null };
  const [paused] = await db
    .update(jobs)
    .set({ usage_limit: pause, nudged_at: null, nudged_stage: null, updated_at: now })
    .where(and(eq(jobs.id, job.id), eq(jobs.stage, job.stage), eq(jobs.attempt, job.attempt)))
    .returning({ key: jobs.key });
  if (paused) log("usage-limit:paused", { key: job.key, stage: job.stage, until: pause.until });
  return Boolean(paused);
}

/**
 * Tells a paused job's thread to go on once its limit has reset, waking its sandbox first. The
 * pause is claimed before the send, so two passes never both resume it; a failed send gives it back.
 * Undefined while the pause lasts; "wake-deferred" while no sandbox has room to wake in.
 */
export async function resumeIfDue(job: ResumableJob, now = new Date()) {
  const pause = activePause(job);
  if (!pause || !resumeDue(pause, now)) return undefined;
  const host = await ensureAwake(job).catch((error: unknown) => {
    if (error instanceof WakeDeferredError) return null;
    throw error;
  });
  if (!host) return "wake-deferred";
  const unclaimed = and(eq(jobs.id, job.id), sql`${jobs.usage_limit}->>'until' = ${pause.until}`, sql`${jobs.usage_limit}->>'resumedAt' is null`);
  const [claimed] = await db
    .update(jobs)
    .set({ usage_limit: { ...pause, resumedAt: now.toISOString() }, updated_at: now })
    .where(unclaimed)
    .returning({ key: jobs.key });
  if (!claimed) return undefined;
  const thread = await threads.read(job.t3_thread_id, host);
  // A thread that went while it slept is the watchdog's to fail, on its next pass. One a T3 with its
  // own auto-resume on already continued, or that hit a limit again, gets no second message.
  if (thread.state !== "stopped" || (thread.limitedUntil && thread.limitedUntil > now)) {
    log("usage-limit:resumed", { key: job.key, stage: job.stage, until: pause.until, sent: false, thread: thread.state });
    return "resumed";
  }
  try {
    await threads.send(job.t3_thread_id!, usageLimitResumeMessage(job.key, factoryPlaybook(jobExecution(job))), host);
  } catch (error) {
    await db.update(jobs).set({ usage_limit: pause }).where(eq(jobs.id, job.id));
    throw error;
  }
  log("usage-limit:resumed", { key: job.key, stage: job.stage, until: pause.until, sent: true });
  return "resumed";
}
