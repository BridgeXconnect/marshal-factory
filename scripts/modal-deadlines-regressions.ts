import "./test-guard";
import assert from "node:assert/strict";
import { ConflictError, NotFoundError } from "modal";
import { fakeModal, FakeSandbox, sandboxes } from "./fake-modal";

const { HostGoneError } = await import("../lib/host");
const { MODAL_DEADLINES_MS, ModalDeadlineError, deleteSnapshot, listSandboxes, modal, modalHost, terminateSandbox, withDeadline } = await import("../lib/modal-host");

// Each deadline is shortened to a few milliseconds; the Modal call under test never settles.
const SHORT = 40;
const never = <T>() => new Promise<T>(() => {});
const original = { ...modal.deadlinesMs };
const logged: { event: string; detail: Record<string, unknown> }[] = [];
modal.log = (event, detail) => void logged.push({ event, detail });
modal.api = fakeModal;

async function test(name: string, body: () => Promise<void>) {
  logged.length = 0;
  sandboxes.clear();
  modal.api = fakeModal;
  Object.assign(modal.deadlinesMs, original, { lookup: SHORT, terminate: SHORT, list: SHORT, deleteImage: SHORT });
  try {
    await body();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}`);
    throw error;
  }
}

try {
  await test("the deadlines are the approved values, in one place", async () => {
    const { lookup, terminate, list, deleteImage } = MODAL_DEADLINES_MS;
    assert.deepEqual({ lookup, terminate, list, deleteImage }, { lookup: 30_000, terminate: 60_000, list: 30_000, deleteImage: 60_000 });
    assert.deepEqual(original, { ...MODAL_DEADLINES_MS }, "the live deadlines start as the constants");
  });

  await test("withDeadline rejects a promise that never settles, and passes through one that does", async () => {
    await assert.rejects(withDeadline("hang", SHORT, never()), (e: Error) => e instanceof ModalDeadlineError && /hang/.test(e.message));
    assert.equal(await withDeadline("fast", SHORT, Promise.resolve(7)), 7);
    await assert.rejects(withDeadline("fails", SHORT, Promise.reject(new Error("boom"))), /boom/, "its own rejection is not a deadline");
  });

  await test("a lookup that never answers is gone, and the cached promise is evicted so the next call asks again", async () => {
    let calls = 0;
    const live = new FakeSandbox("sb-lookup");
    modal.api = {
      ...fakeModal,
      fromId: () => {
        calls++;
        return calls === 1 ? never() : Promise.resolve(live);
      },
    };
    const host = modalHost("sb-lookup");
    await assert.rejects(host.run("true", []), (e: Error) => e instanceof HostGoneError, "the first lookup times out and reads as gone");
    assert.equal(calls, 1);
    // A cached hang would replay as gone for ever; an evicted one asks Modal again and finds the sandbox.
    await host.run("true", []);
    assert.equal(calls, 2, "the second call looked the sandbox up again");
    assert.equal(live.execs.length, 1);
  });

  await test("terminate that never answers is logged and counts as terminated", async () => {
    let terminated = 0;
    modal.api = { ...fakeModal, fromId: async (id) => ({ ...new FakeSandbox(id), sandboxId: id, terminate: () => (terminated++, never()) }) as never };
    await terminateSandbox("sb-term");
    assert.equal(terminated, 1);
    assert.deepEqual(logged.map((l) => l.event), ["modal:terminate-timeout"]);
    assert.equal(logged[0]!.detail.sandbox, "sb-term");
  });

  await test("terminate whose lookup never answers is logged and counts as terminated", async () => {
    modal.api = { ...fakeModal, fromId: () => never() };
    await terminateSandbox("sb-term-lookup");
    assert.deepEqual(logged.map((l) => l.event), ["modal:terminate-timeout"]);
    assert.equal(logged[0]!.detail.lookup, true);
  });

  await test("terminate still throws on an error that is neither gone nor a deadline", async () => {
    modal.api = { ...fakeModal, fromId: async () => Promise.reject(new Error("modal is down")) };
    await assert.rejects(terminateSandbox("sb-term-down"), /modal is down/);
    modal.api = { ...fakeModal, fromId: async () => Promise.reject(new NotFoundError("gone")) };
    await terminateSandbox("sb-term-gone");
    modal.api = { ...fakeModal, fromId: async () => Promise.reject(new ConflictError("already finished")) };
    await terminateSandbox("sb-term-finished");
  });

  await test("list retried once after a hang, then answered", async () => {
    let calls = 0;
    modal.api = { ...fakeModal, list: async () => (++calls === 1 ? never() : [{ sandboxId: "sb-1", tags: {} }]) };
    assert.deepEqual(await listSandboxes("app", {}), [{ sandboxId: "sb-1", tags: {} }]);
    assert.equal(calls, 2, "retried once");
    assert.deepEqual(logged.map((l) => l.event), ["modal:list-timeout"]);
  });

  await test("list that hangs twice is empty and logged, and is not asked a third time", async () => {
    let calls = 0;
    modal.api = { ...fakeModal, list: () => (calls++, never()) };
    assert.deepEqual(await listSandboxes("app", {}), []);
    assert.equal(calls, 2);
    assert.equal(logged.length, 2);
  });

  await test("list still throws an error that is not a deadline", async () => {
    modal.api = { ...fakeModal, list: async () => Promise.reject(new Error("modal is down")) };
    await assert.rejects(listSandboxes("app", {}), /modal is down/);
  });

  await test("deleteImage that never answers is logged and skipped", async () => {
    let calls = 0;
    modal.api = { ...fakeModal, deleteImage: () => (calls++, never()) };
    await deleteSnapshot("im-snap-9");
    assert.equal(calls, 1, "not retried");
    assert.deepEqual(logged.map((l) => l.event), ["modal:delete-image-timeout"]);
    assert.equal(logged[0]!.detail.image, "im-snap-9");
  });

  await test("deleteImage still treats a missing image as deleted and throws on other errors", async () => {
    await deleteSnapshot("im-snap-never-existed");
    modal.api = { ...fakeModal, deleteImage: async () => Promise.reject(new Error("modal is down")) };
    await assert.rejects(deleteSnapshot("im-snap-1"), /modal is down/);
  });

  console.log("modal deadline regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
