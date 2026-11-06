import { z } from "zod";

// A thread whose provider (Claude Code or Codex) hit its usage limit is not stuck and has not
// failed: it sleeps until the limit resets. T3 snoozes such a thread until the reset time
// (runner/threads.ts reads it), and the runner records that here so the watchdog leaves the job
// alone, its sandbox hibernates, and the thread is told to go on once the limit has reset.

/** How long after the reset T3 reports the runner waits before it resumes the thread. */
export const RESUME_AFTER_RESET_MS = 60_000;

const iso = z.string().datetime({ offset: true });

/** jobs.usage_limit: the latest usage-limit pause of the job's attempt. */
export const usageLimitSchema = z.object({
  attempt: z.number().int(),
  /** When T3 says the limit resets. */
  until: iso,
  since: iso,
  /** Set once the runner told the thread to go on; the pause is over. */
  resumedAt: iso.nullable(),
});
export type UsageLimit = z.infer<typeof usageLimitSchema>;

export function parseUsageLimit(value: unknown): UsageLimit | null {
  const parsed = usageLimitSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The pause the job's current attempt sleeps in, if any. */
export function activePause(job: { attempt: number; usage_limit: unknown }): UsageLimit | null {
  const pause = parseUsageLimit(job.usage_limit);
  return pause && pause.attempt === job.attempt && pause.resumedAt === null ? pause : null;
}

/** When the job's current attempt was last resumed from a pause; its quiet is counted from then. */
export function resumedAt(job: { attempt: number; usage_limit: unknown }): Date | null {
  const pause = parseUsageLimit(job.usage_limit);
  return pause && pause.attempt === job.attempt && pause.resumedAt ? new Date(pause.resumedAt) : null;
}

export const resumeDue = (pause: UsageLimit, now: Date) => now.getTime() >= Date.parse(pause.until) + RESUME_AFTER_RESET_MS;

export function usageLimitResumeMessage(key: string, playbook: string) {
  return [
    `The usage limit that paused factory run ${key} has reset.`,
    "",
    `Continue the factory playbook (${playbook}) where you left off. Call report_stage with your current stage now.`,
  ].join("\n");
}
