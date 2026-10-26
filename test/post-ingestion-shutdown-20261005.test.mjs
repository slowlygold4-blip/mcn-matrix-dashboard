import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { drainPostIngestionReviewForShutdown } from "../lib/shutdown-drain.mjs";

test("committed review write may settle within the shutdown grace", async () => {
  const result = await drainPostIngestionReviewForShutdown({
    reviewPromise: new Promise((resolve) => setTimeout(resolve, 8)),
    timeoutMs: 100,
  });
  assert.deepEqual(result, { drained: true, timedOut: false, error: null });
});

test("review writer rejection is reported as a drain error, not a timeout", async () => {
  const error = new Error("receipt write failed");
  const result = await drainPostIngestionReviewForShutdown({
    reviewPromise: Promise.reject(error),
    timeoutMs: 100,
  });
  assert.equal(result.drained, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, error);
});

test("an unsettled receipt returns a bounded timeout and referenced timer keeps Node alive", () => {
  const moduleUrl = new URL("../lib/shutdown-drain.mjs", import.meta.url).href;
  const script = [
    `import { drainPostIngestionReviewForShutdown } from ${JSON.stringify(moduleUrl)};`,
    "const started = Date.now();",
    "const result = await drainPostIngestionReviewForShutdown({ reviewPromise: new Promise(() => {}), timeoutMs: 25 });",
    "console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout.trim());
  assert.equal(output.drained, false);
  assert.equal(output.timedOut, true);
  assert.equal(output.error, null);
  assert.ok(output.elapsedMs >= 15, `expected referenced timeout to hold child open, got ${output.elapsedMs}ms`);
  assert.ok(output.elapsedMs < 1_000, `expected bounded timeout, got ${output.elapsedMs}ms`);
});
