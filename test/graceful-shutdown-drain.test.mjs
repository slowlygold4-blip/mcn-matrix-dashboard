import test from "node:test";
import assert from "node:assert/strict";
import { drainSchedulerForShutdown } from "../lib/shutdown-drain.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("works-only run may finalize within its grace window without abort", async () => {
  const pending = deferred();
  const controller = new AbortController();
  const resultPromise = drainSchedulerForShutdown({
    schedulerDrain: pending.promise,
    activeCollectionDrain: pending.promise,
    controller,
    activeTrigger: "works-only",
    worksOnlyGraceMs: 100,
    abortGraceMs: 20,
  });
  setTimeout(() => pending.resolve(), 10);
  assert.deepEqual(await resultPromise, { drained: true, aborted: false, forced: false, timedOut: false });
  assert.equal(controller.signal.aborted, false);
});

test("active works-only request is aborted only after the grace deadline", async () => {
  const pending = deferred();
  const controller = new AbortController();
  pending.promise.catch(() => {});
  const resultPromise = drainSchedulerForShutdown({
    schedulerDrain: pending.promise,
    activeCollectionDrain: pending.promise,
    controller,
    activeTrigger: "works-only",
    worksOnlyGraceMs: 10,
    abortGraceMs: 100,
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(controller.signal.aborted, false);
  controller.signal.addEventListener("abort", () => pending.resolve(), { once: true });
  assert.deepEqual(await resultPromise, { drained: true, aborted: true, forced: true, timedOut: false });
  assert.equal(controller.signal.aborted, true);
});

test("non-works batch keeps immediate abort and bounded cleanup", async () => {
  const controller = new AbortController();
  const pending = new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
  assert.deepEqual(await drainSchedulerForShutdown({
    schedulerDrain: pending,
    activeCollectionDrain: pending,
    controller,
    activeTrigger: "scheduled",
    worksOnlyGraceMs: 100,
    abortGraceMs: 20,
  }), { drained: true, aborted: true, forced: true, timedOut: false });
  assert.equal(controller.signal.aborted, true);
});

test("unresponsive shutdown reports both bounded timeouts", async () => {
  const controller = new AbortController();
  let graceTimedOut = 0;
  let abortTimedOut = 0;
  assert.deepEqual(await drainSchedulerForShutdown({
    schedulerDrain: new Promise(() => {}),
    activeCollectionDrain: new Promise(() => {}),
    controller,
    activeTrigger: "works-only",
    worksOnlyGraceMs: 5,
    abortGraceMs: 5,
    onWorksGraceTimeout: () => { graceTimedOut += 1; },
    onAbortTimeout: () => { abortTimedOut += 1; },
  }), { drained: false, aborted: true, forced: true, timedOut: true });
  assert.equal(controller.signal.aborted, true);
  assert.equal(graceTimedOut, 1);
  assert.equal(abortTimedOut, 1);
});

test("drain failure aborts collection and remains visible", async () => {
  const controller = new AbortController();
  const errors = [];
  let abortTimedOut = 0;
  let releaseFallback;
  const fallback = new Promise((resolve) => { releaseFallback = resolve; });
  const result = await drainSchedulerForShutdown({
    schedulerDrain: Promise.reject(new Error("drain failed")),
    activeCollectionDrain: fallback,
    controller,
    activeTrigger: "works-only",
    worksOnlyGraceMs: 50,
    abortGraceMs: 5,
    onDrainError: (error) => errors.push(error.message),
    onAbortTimeout: () => { abortTimedOut += 1; },
  });
  assert.deepEqual(result, { drained: false, aborted: true, forced: true, timedOut: true });
  assert.deepEqual(errors, ["drain failed"]);
  assert.equal(controller.signal.aborted, true);
  assert.equal(abortTimedOut, 1, "an unresolved activity fallback must time out");
});

test("works-only activity drain failure is reported without a false timeout", async () => {
  const controller = new AbortController();
  const errors = [];
  let graceTimedOut = 0;
  let abortTimedOut = 0;
  const result = await drainSchedulerForShutdown({
    schedulerDrain: Promise.resolve(),
    activeCollectionDrain: Promise.reject(new Error("activity snapshot failed")),
    controller,
    activeTrigger: "works-only",
    worksOnlyGraceMs: 50,
    abortGraceMs: 50,
    onDrainError: (error) => errors.push(error.message),
    onWorksGraceTimeout: () => { graceTimedOut += 1; },
    onAbortTimeout: () => { abortTimedOut += 1; },
  });
  assert.deepEqual(result, { drained: false, aborted: true, forced: true, timedOut: false });
  assert.deepEqual(errors, ["activity snapshot failed"]);
  assert.equal(controller.signal.aborted, true);
  assert.equal(graceTimedOut, 0, "a completed rejection is not a grace-window timeout");
  assert.equal(abortTimedOut, 0, "a completed rejection is not an abort-drain timeout");
});

test("non-works drain rejection uses immediate cancellation without claiming a timeout", async () => {
  const controller = new AbortController();
  let abortTimedOut = 0;
  const activeCollection = new Promise((resolve) => {
    controller.signal.addEventListener("abort", () => setTimeout(resolve, 2), { once: true });
  });
  const result = await drainSchedulerForShutdown({
    schedulerDrain: Promise.reject(new Error("drain failed")),
    activeCollectionDrain: activeCollection,
    controller,
    activeTrigger: "scheduled",
    abortGraceMs: 5,
    onAbortTimeout: () => { abortTimedOut += 1; },
  });
  assert.deepEqual(result, { drained: true, aborted: true, forced: true, timedOut: false });
  assert.equal(controller.signal.aborted, true);
  assert.equal(abortTimedOut, 0);
});
