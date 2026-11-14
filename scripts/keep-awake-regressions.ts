import "./test-guard";
import assert from "node:assert/strict";
import { keepAwake } from "../lib/keep-awake";

type Call = { command: string; args: string[]; options: unknown };
const spawned = () => {
  const calls: Call[] = [];
  let errored: ((error: Error) => void) | undefined;
  let unreffed = false;
  const run = (command: string, args: string[], options: { detached: true; stdio: "ignore" }) => {
    calls.push({ command, args, options });
    return {
      on: (_event: "error", listener: (error: Error) => void) => void (errored = listener),
      unref: () => void (unreffed = true),
    };
  };
  return { calls, run, fail: (message: string) => errored?.(new Error(message)), unreffed: () => unreffed };
};
const events: [string, Record<string, unknown> | undefined][] = [];
const log = (event: string, detail?: Record<string, unknown>) => void events.push([event, detail]);

// On a Mac it holds the no-sleep assertion for the runner's own pid, detached, and leaves nothing behind.
const mac = spawned();
assert.equal(keepAwake(log, { pid: 4242, platform: "darwin", run: mac.run }), true);
assert.deepEqual(mac.calls, [{ command: "caffeinate", args: ["-s", "-w", "4242"], options: { detached: true, stdio: "ignore" } }], "caffeinate -s -w <pid>, detached and silent");
assert.equal(mac.unreffed(), true, "the runner does not wait for it");
assert.deepEqual(events.at(-1), ["keep-awake", { pid: 4242 }]);

// A caffeinate that cannot start is logged, never thrown.
mac.fail("spawn caffeinate ENOENT");
assert.deepEqual(events.at(-1), ["keep-awake:failed", { error: "spawn caffeinate ENOENT" }]);

// Anywhere else there is no caffeinate to run.
const linux = spawned();
assert.equal(keepAwake(log, { platform: "linux", run: linux.run }), false);
assert.deepEqual(linux.calls, [], "nothing is spawned off macOS");

// By default it watches this process.
const self = spawned();
keepAwake(log, { platform: "darwin", run: self.run });
assert.equal(self.calls[0]!.args[2], String(process.pid));

console.log("keep-awake regressions passed");
