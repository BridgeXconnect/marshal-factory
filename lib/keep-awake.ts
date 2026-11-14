import { spawn } from "node:child_process";

type Spawn = (command: string, args: string[], options: { detached: true; stdio: "ignore" }) => {
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};

/**
 * Keeps a Mac awake while this process lives: `caffeinate -s -w <pid>` holds a "no system sleep"
 * assertion and exits on its own when the process does, however it ends, so a restart by launchd
 * re-arms it and nothing outlives the runner. Detached, so it is not part of the runner's own
 * process group.
 *
 * The assertion is honoured only on AC power (caffeinate's -s), and a closed lid on battery sleeps
 * the Mac regardless. It is a safeguard for a plugged-in laptop, not a guarantee.
 */
export function keepAwake(
  log: (event: string, detail?: Record<string, unknown>) => void,
  { pid = process.pid, platform = process.platform, run = spawn as unknown as Spawn }: { pid?: number; platform?: string; run?: Spawn } = {},
) {
  if (platform !== "darwin") return false;
  const child = run("caffeinate", ["-s", "-w", String(pid)], { detached: true, stdio: "ignore" });
  child.on("error", (error) => log("keep-awake:failed", { error: error.message }));
  child.unref();
  log("keep-awake", { pid });
  return true;
}
