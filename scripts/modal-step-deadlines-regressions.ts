import "./test-guard";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxImage } from "../lib/sandbox";
import { fake, fakeModal, FakeSandbox, sandboxes } from "./fake-modal";

const { HostGoneError } = await import("../lib/host");
const { MODAL_DEADLINES_MS, ModalDeadlineError, modal, modalHost } = await import("../lib/modal-host");
const { factorySchema } = await import("../lib/config");
const { pinnedVersions, readSandboxImage } = await import("../lib/sandbox");
const { buildLockPath, buildSandboxImage } = await import("../lib/sandbox-image-build");

// Each deadline is shortened to a few milliseconds; the Modal call under test never settles.
const SHORT = 40;
const never = <T>() => new Promise<T>(() => {});
const original = { ...modal.deadlinesMs };
const logged: string[] = [];
modal.log = (event) => void logged.push(event);
modal.api = fakeModal;

const isDeadline = (e: unknown) => e instanceof ModalDeadlineError && !(e instanceof HostGoneError);

async function test(name: string, body: () => Promise<void>) {
  logged.length = 0;
  sandboxes.clear();
  fake.answer = () => ({});
  modal.api = fakeModal;
  Object.assign(modal.deadlinesMs, original, { readText: SHORT, writeText: SHORT, execStart: SHORT, stdin: SHORT, imageBuild: SHORT * 5, terminate: SHORT });
  try {
    await body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}`);
    throw error;
  }
}

/** A sandbox the host reaches, whose filesystem and exec calls the test can replace. */
function sandbox(id: string) {
  const box = new FakeSandbox(id);
  sandboxes.set(id, box);
  return box;
}

try {
  await test("the step deadlines are the approved values, in one place", async () => {
    assert.equal(MODAL_DEADLINES_MS.readText, 30_000);
    assert.equal(MODAL_DEADLINES_MS.writeText, 60_000);
    assert.equal(MODAL_DEADLINES_MS.execStart, 60_000);
    assert.equal(MODAL_DEADLINES_MS.stdin, 30_000);
    assert.equal(MODAL_DEADLINES_MS.imageBuild, 10 * 60_000);
  });

  await test("readText that hangs once is retried and answers", async () => {
    const box = sandbox("sb-read-once");
    box.files.set("/f", "hello");
    const answer = box.filesystem.readText;
    let calls = 0;
    box.filesystem.readText = (path) => (++calls === 1 ? never() : answer(path));
    assert.equal(await modalHost("sb-read-once").readFile("/f"), "hello");
    assert.equal(calls, 2, "retried once");
    assert.deepEqual(logged, ["modal:retry-after-timeout"]);
  });

  await test("readText that hangs twice fails the step, and is not asked a third time", async () => {
    const box = sandbox("sb-read-twice");
    let calls = 0;
    box.filesystem.readText = () => (calls++, never());
    await assert.rejects(modalHost("sb-read-twice").readFile("/f"), isDeadline);
    assert.equal(calls, 2);
  });

  await test("readText still returns null for a missing file", async () => {
    sandbox("sb-read-missing");
    assert.equal(await modalHost("sb-read-missing").readFile("/nope"), null);
  });

  await test("writeText that hangs once is retried and lands, with no mkdir", async () => {
    const box = sandbox("sb-write-once");
    const write = box.filesystem.writeText;
    let calls = 0;
    box.filesystem.writeText = (data, path) => (++calls === 1 ? never() : write(data, path));
    await modalHost("sb-write-once").writeFile("/d/f", "text");
    assert.equal(calls, 2, "retried once");
    assert.equal(box.files.get("/d/f"), "text");
    assert.equal(box.execs.length, 0, "a silence is not a missing directory, so nothing ran mkdir");
  });

  await test("writeText that hangs twice fails the step without running mkdir", async () => {
    const box = sandbox("sb-write-twice");
    let calls = 0;
    box.filesystem.writeText = () => (calls++, never());
    await assert.rejects(modalHost("sb-write-twice").writeFile("/d/f", "text"), isDeadline);
    assert.equal(calls, 2);
    assert.equal(box.execs.length, 0);
  });

  await test("writeText still makes a missing directory", async () => {
    fake.parentsRequired = true;
    try {
      const box = sandbox("sb-write-dir");
      await modalHost("sb-write-dir").writeFile("/new/dir/f", "text");
      assert.equal(box.files.get("/new/dir/f"), "text");
      assert.deepEqual(box.execs.map((e) => e.argv[0]), ["mkdir"]);
    } finally {
      fake.parentsRequired = false;
    }
  });

  await test("an exec whose start never answers fails the step, and is not started twice", async () => {
    const box = sandbox("sb-exec");
    let calls = 0;
    box.exec = () => (calls++, never());
    await assert.rejects(modalHost("sb-exec").run("echo", ["hi"]), isDeadline);
    assert.equal(calls, 1, "no retry");
  });

  await test("a stdin write that never answers fails the step", async () => {
    const box = sandbox("sb-stdin-write");
    const exec = box.exec.bind(box);
    box.exec = async (argv, params) => ({ ...(await exec(argv, params)), stdin: { writeText: () => never(), close: async () => {} } });
    await assert.rejects(modalHost("sb-stdin-write").run("cat", [], { input: "x" }), isDeadline);
  });

  await test("a stdin close that never answers fails the step", async () => {
    const box = sandbox("sb-stdin-close");
    const exec = box.exec.bind(box);
    box.exec = async (argv, params) => ({ ...(await exec(argv, params)), stdin: { writeText: async () => {}, close: () => never() } });
    await assert.rejects(modalHost("sb-stdin-close").run("cat", []), isDeadline);
  });

  await test("a stdin error that is not a deadline is still reported on the command, not thrown", async () => {
    const box = sandbox("sb-stdin-error");
    const exec = box.exec.bind(box);
    fake.answer = () => ({ code: 1, stderr: "no input" });
    box.exec = async (argv, params) => ({ ...(await exec(argv, params)), stdin: { writeText: async () => Promise.reject(new Error("broken pipe")), close: async () => {} } });
    await assert.rejects(modalHost("sb-stdin-error").run("cat", [], { input: "x" }), (e: Error & { stdinError?: Error }) => e.stdinError?.message === "broken pipe");
  });

  // The image build step: a build sandbox whose first command never answers.
  const limits = factorySchema.parse({}).sandbox;
  const dir = mkdtempSync(join(tmpdir(), "step-deadlines-"));
  const oldImage: SandboxImage = { imageId: "im-old", t3Version: limits.t3Version, versions: { ...pinnedVersions(limits), claudeCode: "2.1.309" }, factoryCommit: "abc1234", builtAt: "2026-10-28T10:00:00.000Z" };

  await test("a sandbox image build that outruns its deadline fails, ends the sandbox and records nothing", async () => {
    const path = join(dir, "hang.json");
    writeFileSync(path, `${JSON.stringify(oldImage, null, 2)}\n`);
    const box = new FakeSandbox("sb-build-hang");
    fake.answer = () => ({ hang: true });
    await assert.rejects(buildSandboxImage({ limits, log: () => {}, open: async () => box, path }), isDeadline);
    assert.equal(box.terminated, true, "the build sandbox is ended");
    assert.equal(readSandboxImage(path)!.imageId, "im-old", "and the old image stays recorded");
    assert.equal(existsSync(buildLockPath(path)), false, "with the lock released");
    assert.equal(fake.snapshots.filter((s) => s.sandboxId === box.sandboxId).length, 0, "and nothing was snapshotted");
  });

  await test("a build whose sandbox never opens fails at the deadline and ends the sandbox that opens late", async () => {
    const path = join(dir, "open-hang.json");
    writeFileSync(path, `${JSON.stringify(oldImage, null, 2)}\n`);
    const box = new FakeSandbox("sb-build-late");
    let up: (box: FakeSandbox) => void = () => {};
    await assert.rejects(buildSandboxImage({ limits, log: () => {}, open: () => new Promise((resolve) => (up = resolve)), path }), isDeadline);
    assert.equal(existsSync(buildLockPath(path)), false, "the lock is released");
    up(box);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(box.terminated, true, "the sandbox that opens after the deadline is ended");
    assert.equal(readSandboxImage(path)!.imageId, "im-old");
  });

  console.log("modal step deadline regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
