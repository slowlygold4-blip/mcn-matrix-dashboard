import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, chmod, access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MonitorDatabase } from "../lib/database.mjs";
import { MonitorScheduler } from "../lib/scheduler.mjs";
import { normalizeCollection } from "../lib/providers/normalize.mjs";
import { planWorksOnly } from "../lib/works-only-scheduler.mjs";

const SEC_UID = "MS4wLjABAAAASigtermWorksOnlyFixtureAccount123";
const UID = "12345678";

async function waitForFile(path, child, logs, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return true; } catch {}
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`等待临时夹具标记超时：${path}\n${logs()}`);
}

async function exerciseWorksOnlySigterm(t, { timeoutMode = false } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "monitor-works-sigterm-"));
    const databasePath = join(directory, "douyin-monitor.sqlite");
    const markers = Object.fromEntries(["started", "sigterm", "release", "completed", "cancelled", "unexpected-profile"]
      .map((name) => [name, join(directory, `${name}.marker`)]));

    // Seed only this temporary DB with the exact evidence needed to enter the
    // existing works-only lane. It is deliberately a profile-only snapshot;
    // the test collector below is the sole source of its fake works response.
    const seed = new MonitorDatabase(databasePath);
    // Use the actual Beijing clock, but put the eight-hour slot boundary two
    // minutes behind it. This avoids a runner crossing 02/10/18:00 while the
    // DB is seeded and the child starts, which would correctly make the anchor
    // belong to the prior slot and leave the works-only lane empty.
    const stableAnchor = new Date(Date.now() + 8 * 60 * 60_000 - 2 * 60_000);
    const scheduleTime = `${String(stableAnchor.getUTCHours()).padStart(2, "0")}:${String(stableAnchor.getUTCMinutes()).padStart(2, "0")}`;
    seed.setSettings({ scheduleTime });
    const target = seed.createTarget({ type: "account", provider: "public-web", label: "isolated works fixture",
      locator: SEC_UID, metadata: { platform: "douyin" } });
    const capturedAt = new Date().toISOString();
    const raw = { capturedAt, accountStatus: "validated", accountError: null,
      profile: { user: { sec_uid: SEC_UID, uid: UID, nickname: "isolated fixture", follower_count: 23,
        total_favorited: 41, aweme_count: 7 } },
      worksCoverage: "unavailable", worksErrorCode: "deferred",
      works: { stopReason: "request-deferred", pagination: { requestCount: 0, pages: [] } },
      provenance: { mode: "guest-ttwid-unsigned-profile", profileMode: "guest-ttwid-unsigned-profile",
        profileEndpoint: "https://www.douyin.com/aweme/v1/web/user/profile/other/", accountLocator: "sec_uid",
        cookiePersisted: false, runtimeAI: false, paidAPI: false } };
    const seedRun = seed.beginRun("scheduled", target.id, 1);
    seed.saveCollection(target, seedRun, normalizeCollection(target, raw, { capturedAt }));
    seed.finishRun(seedRun, { status: "partial", successCount: 1, warningCount: 1, processedCount: 1 });
    const now = new Date();
    const planner = new MonitorScheduler(seed, { scheduleIntervalHours: 8, scheduleTimeZone: "Asia/Shanghai",
      worksOnlyEnabled: true, providerOptions: { accountBrowserFallback: true } });
    const slot = planner.collectionSlot(now);
    assert.ok(slot, "current Beijing slot must exist");
    assert.deepEqual(planner.scheduledDueTargetIds(planner.scheduledDateKey(now), now, slot), [],
      "the seeded profile must close ordinary profile admission for this slot");
    const expectedWorks = planWorksOnly(seed, planner.scheduledTargetAttemptStates(planner.scheduledDateKey(now), slot), { now, slot });
    assert.deepEqual(expectedWorks.due.map((item) => item.target.id), [target.id],
      `fresh temporary DB must deterministically admit exactly the works-only target in ${slot.key}`);
    seed.close();

    const projectDir = fileURLToPath(new URL("..", import.meta.url));
    const providerUrl = pathToFileURL(join(projectDir, "lib/providers/public-web.mjs")).href;
    const hookPath = join(directory, "offline-provider-fixture.mjs");
    await writeFile(hookPath, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { PublicWebProvider } from ${JSON.stringify(providerUrl)};

const markers = ${JSON.stringify(markers)};
const timeoutMode = ${JSON.stringify(timeoutMode)};
if (isMainThread) process.on("SIGTERM", () => writeFileSync(markers.sigterm, String(Date.now())));
// Fail closed if an unexpected code path tries to reach any HTTP service.
globalThis.fetch = async () => { throw new Error("NETWORK_DISABLED_BY_TEST_FIXTURE"); };
PublicWebProvider.prototype.testConnection = async () => ({ ok: true, fixture: true });
PublicWebProvider.prototype.testConnectionForPlatform = async () => ({ ok: true, fixture: true });
PublicWebProvider.prototype.collect = async () => {
  writeFileSync(markers["unexpected-profile"], "profile collection was not expected");
  throw new Error("PROFILE_COLLECTION_DISABLED_BY_TEST_FIXTURE");
};
PublicWebProvider.prototype.runBrowserWorks = async function (request, { signal } = {}) {
  writeFileSync(markers.started, JSON.stringify({ key: request.key, secUid: request.secUid }));
  const deadline = Date.now() + 6_000;
  while (!existsSync(markers.release)) {
    if (signal?.aborted) {
      writeFileSync(markers.cancelled, JSON.stringify({ signalAbortedAt: Date.now(), sigtermAt: Number(readFileSync(markers.sigterm, "utf8")) }));
      throw Object.assign(new Error("fixture aborted"), { name: "AbortError", code: "ABORT_ERR" });
    }
    if (!timeoutMode && Date.now() >= deadline) throw new Error("fixture release marker was not provided");
    await delay(10);
  }
  await delay(80);
  const observedAt = new Date().toISOString();
  const post = { aweme_id: "7200000000000000001", author: { sec_uid: request.secUid, uid: ${JSON.stringify(UID)} },
    statistics: { digg_count: 8, comment_count: 2 }, desc: "isolated fake work", create_time: Math.floor(Date.now() / 1000) };
  writeFileSync(markers.completed, JSON.stringify({ signalAborted: Boolean(signal?.aborted), observedAt }));
  return { items: [{ key: request.key, secUid: request.secUid, status: "ok", worksCoverage: "complete", errorCode: null,
    posts: [post], hasMore: false, maxCursor: 0, pagination: { version: 1, maxPages: 3, requestCount: 1,
      collectedCount: 1, stopReason: "end-of-list", errorCode: null,
      pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1,
        duplicateCount: 0, filteredCount: 0, truncated: false, observedAt }] } }],
    provenance: { mode: "offline-test-fixture" } };
};
`);

    const port = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const value = probe.address().port;
        probe.close(() => resolve(value));
      });
    });
    const fakePython = join(directory, "fake-python.mjs");
    await writeFile(fakePython, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,data:{fixture:true}}));\n`);
    await chmod(fakePython, 0o700);

    let output = "";
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: projectDir,
      env: { ...process.env, NODE_ENV: "test", DATA_DIR: directory, HOST: "127.0.0.1", PORT: String(port),
        PYTHON_BIN: fakePython, DOUYIN_ACCOUNT_BROWSER_FALLBACK: "true", DOUYIN_TOPIC_RESOLVER_MODE: "public",
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(hookPath).href}`].filter(Boolean).join(" ") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    const logs = () => output;
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    });

    await waitForFile(markers.started, child, logs);
    const started = JSON.parse(await readFile(markers.started, "utf8"));
    assert.equal(started.secUid, SEC_UID, logs());

    // Deliver SIGTERM while the fake collector is paused. Wait until the test
    // preload observes the OS signal before releasing or awaiting cancellation.
    assert.equal(child.kill("SIGTERM"), true, logs());
    await waitForFile(markers.sigterm, child, logs);
    if (timeoutMode) {
      // This intentionally uses the production 60-second grace window. Do not
      // override the server constant or shorten the timer in this fixture.
      await waitForFile(markers.cancelled, child, logs, 67_000);
      const cancelled = JSON.parse(await readFile(markers.cancelled, "utf8"));
      assert.ok(cancelled.signalAbortedAt - cancelled.sigtermAt >= 60_000,
        `works-only cancellation preceded the real 60s grace: ${JSON.stringify(cancelled)}\n${logs()}`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 120));
      try { await access(markers.cancelled); assert.fail("works-only signal was cancelled inside its graceful window"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      await writeFile(markers.release, "return one locally generated works observation");
    }

    const exit = await exited;
    assert.deepEqual(exit, { code: 0, signal: null }, logs());
    if (!timeoutMode) {
      const completed = JSON.parse(await readFile(markers.completed, "utf8"));
      assert.equal(completed.signalAborted, false, logs());
    }
    try { await access(markers["unexpected-profile"]); assert.fail("unexpected profile request path was entered"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }

    // Read-only reopen is an independent check that all writes and the
    // post-ingestion callback settled before the production connection closed.
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(reopened.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      const run = reopened.prepare("SELECT * FROM runs WHERE trigger_type='works-only' ORDER BY id DESC LIMIT 1").get();
      assert.ok(run, logs());
      assert.equal(run.status, timeoutMode ? "interrupted" : "partial", logs());
      assert.equal(run.processed_count, 1, logs());
      assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM works_observations WHERE run_id=?").get(run.id).n, timeoutMode ? 0 : 1, logs());
      if (timeoutMode) {
        assert.equal(run.error_count, 1, logs());
        assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM posts WHERE target_id=? AND external_id='7200000000000000001'").get(target.id).n, 0, logs());
        const details = JSON.parse(run.details_json);
        assert.equal(details[0].mode, "works-only");
        assert.equal(details[0].errorCode, "collector_error");
        assert.equal(details[0].attempted, null);
      } else {
        assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM posts WHERE target_id=? AND external_id='7200000000000000001'").get(target.id).n, 1, logs());
        assert.equal(reopened.prepare("SELECT m.likes FROM post_metrics m JOIN posts p ON p.id=m.post_id WHERE p.target_id=? AND p.external_id='7200000000000000001'").get(target.id).likes, 8, logs());
      }
      const receipt = JSON.parse(await readFile(join(directory, "ingestion-reviews", `run-${run.id}.json`), "utf8"));
      assert.equal(receipt.runId, run.id);
      assert.equal(receipt.triggerType, "works-only");
      assert.equal(receipt.runStatus, timeoutMode ? "interrupted" : "partial");
      assert.equal(receipt.snapshotCount, 0);
      assert.equal(receipt.worksObservationCount, timeoutMode ? 0 : 1);
      assert.equal(receipt.worksOnly.persisted, timeoutMode ? 0 : 1);
      assert.equal(receipt.worksOnly.accepted, timeoutMode ? 0 : 1);
      if (timeoutMode) assert.equal(receipt.worksOnly.attempted, null);
      assert.equal(receipt.productReview.status, "pending");
      assert.doesNotMatch(logs(), /database is not open|database.*closed|NETWORK_DISABLED_BY_TEST_FIXTURE/);
    } finally { reopened.close(); }
}

test("real server SIGTERM lets works-only finish naturally before SQLite closes",
  { timeout: 15_000 }, async (t) => exerciseWorksOnlySigterm(t));

test("real server SIGTERM waits the full works-only grace, cancels, persists interruption, then closes SQLite",
  { timeout: 80_000 }, async (t) => exerciseWorksOnlySigterm(t, { timeoutMode: true }));
