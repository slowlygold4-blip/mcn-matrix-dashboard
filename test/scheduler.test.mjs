import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { MonitorScheduler } from "../lib/scheduler.mjs";
import { localDateKey } from "../lib/utils.mjs";

function successfulAccountPayload(id = "P1", warnings = []) {
  return JSON.stringify({
    ok: true,
    data: {
      profile: { user: { follower_count: 8, total_favorited: 100, aweme_count: 1 } },
      works: { aweme_list: [{ aweme_id: id, desc: "作品", statistics: { digg_count: 5 } }] },
      warnings,
    },
  });
}

test("explicit collection refuses a paused target without creating a run or invoking a provider", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scheduler-paused-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const paused = database.createTarget({ type: "account", label: "暂停", locator: "MS4wLjPaused", provider: "public-web", enabled: false });
  let calls = 0;
  const scheduler = new MonitorScheduler(database, { providerOptions: { execFileImpl: () => { calls += 1; }, cooldownMs: 0 } });
  await assert.rejects(scheduler.runAll({ targetId: paused.id }), /已暂停监控/);
  scheduler.running = true;
  scheduler.currentPromise = Promise.resolve({ status: "success" });
  await assert.rejects(scheduler.runAll({ targetId: paused.id }), /已暂停监控/);
  assert.equal(calls, 0);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0);
  assert.equal(database.getTarget(paused.id).enabled, false);
});

test("pausing during a collection preserves prior metrics and status on both successful and failed response", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scheduler-pause-inflight-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const fail of [false, true]) {
    const target = database.createTarget({ type: "account", label: `采集中暂停${fail}`, locator: `MS4wLjPauseInflight${fail}`, provider: "public-web" });
    const original = database.getTarget(target.id);
    const scheduler = new MonitorScheduler(database, { providerOptions: { cooldownMs: 0, execFileImpl: (_f, _a, _o, callback) => {
      database.updateTarget(target.id, { enabled: false });
      const payload = JSON.parse(successfulAccountPayload(`pause-${fail}`));
      Object.assign(payload.data.profile.user, { sec_uid: target.locator, unique_id: `pause-${fail}`, nickname: target.label });
      payload.data.works.aweme_list[0].author = { sec_uid: target.locator };
      callback(fail ? new Error("fixture transport failure") : null, fail ? "" : JSON.stringify(payload), "");
    } } });
    const result = await scheduler.runAll({ targetId: target.id });
    assert.equal(result.skippedCount, 1);
    assert.equal(result.errorCount, 0);
    assert.match(result.details[0].message, fail ? /未改写原状态/ : /未保存本次结果/);
    assert.equal(database.getTarget(target.id).enabled, false);
    assert.equal(database.getTarget(target.id).last_checked_at, original.last_checked_at);
    assert.equal(database.getTarget(target.id).last_status, original.last_status);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE target_id=?").get(target.id).n, 0);
  }
});

test("a target paused after batch selection is skipped before its provider is called", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scheduler-pause-roster-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  database.createTarget({ type: "account", label: "先采", locator: "MS4wLjA", provider: "public-web" });
  database.createTarget({ type: "account", label: "后暂停", locator: "MS4wLjB", provider: "public-web" });
  const second = database.listTargets()[1];
  let calls = 0;
  const scheduler = new MonitorScheduler(database, { providerOptions: { cooldownMs: 0, execFileImpl: (_f, _a, _o, callback) => {
    calls += 1;
    database.updateTarget(second.id, { enabled: false });
    callback(null, successfulAccountPayload(), "");
  } } });
  const result = await scheduler.runAll({ triggerType: "scheduled" });
  assert.equal(calls, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.successCount, 1);
});

test("scheduler runs the public provider and skips manual targets", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-scheduler-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.createTarget({ type: "account", label: "公开账号", locator: "MS4wLjX", provider: "public-web", metadata: {} });
  database.createTarget({ type: "hashtag", label: "手动", locator: "y", provider: "manual", metadata: {} });
  const execFileImpl = (_file, _args, _options, callback) => callback(null, JSON.stringify({ ok: true, data: { profile: { user: { follower_count: 8, total_favorited: 100 } }, works: { aweme_list: [{ aweme_id: "P1", desc: "作品", statistics: { digg_count: 5 } }] } } }), "");
  const scheduler = new MonitorScheduler(database, { providerOptions: { execFileImpl, cooldownMs: 0 } });
  const result = await scheduler.runAll({ triggerType: "test" });
  assert.equal(result.status, "success");
  assert.equal(result.successCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(database.listTargets().find((target) => target.label === "公开账号").known_posts, 1);
});

test("scheduler status distinguishes completed, partial, failed and interrupted daily runs", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-status-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const now = new Date();
  const beforeNow = new Date(now.getTime() - 60_000);
  database.setSettings({ scheduleTime: `${String(beforeNow.getHours()).padStart(2, "0")}:${String(beforeNow.getMinutes()).padStart(2, "0")}` });
  const scheduler = new MonitorScheduler(database);

  const partial = database.beginRun("scheduled", null, 2);
  database.finishRun(partial, { status: "partial", successCount: 1, errorCount: 1, processedCount: 2 });
  assert.equal(scheduler.getStatus().scheduleState, "partial");

  const failed = database.beginRun("scheduled", null, 2);
  database.finishRun(failed, { status: "error", successCount: 0, errorCount: 2, processedCount: 2 });
  assert.equal(scheduler.getStatus().scheduleState, "failed");

  const interrupted = database.beginRun("scheduled", null, 2);
  assert.equal(scheduler.getStatus().scheduleState, "interrupted");
  assert.equal(scheduler.getStatus().lastScheduledRunStatus, "running");
  assert.equal(scheduler.getStatus().lastScheduledRunFinishedAt, null);
  database.finishRun(interrupted, { status: "success", successCount: 2, processedCount: 2 });
  assert.equal(scheduler.getStatus().scheduleState, "completed");
});

test("scheduler keeps the last tick failure visible until a later successful tick", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-error-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "23:59" });
  const scheduler = new MonitorScheduler(database);
  scheduler.recordTickError(new Error("模拟公开源超时"));
  const failed = scheduler.getStatus();
  assert.equal(failed.lastError, "模拟公开源超时");
  assert.ok(failed.lastErrorAt);
  await scheduler.tick(new Date("2026-09-10T00:00:00Z"));
  const recovered = scheduler.getStatus();
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.lastErrorAt, null);
  assert.equal(recovered.lastSuccessfulTickAt, "2026-09-10T00:00:00.000Z");
});

test("a successful retry cannot hide an unresolved target in the daily plan", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-aggregate-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const now = new Date();
  const beforeNow = new Date(now.getTime() - 60_000);
  database.setSettings({ scheduleTime: `${String(beforeNow.getHours()).padStart(2, "0")}:${String(beforeNow.getMinutes()).padStart(2, "0")}` });
  const first = database.createTarget({ type: "account", label: "已完成", locator: "MS4wLjCompleted", provider: "public-web", metadata: {} });
  const second = database.createTarget({ type: "account", label: "仍失败", locator: "MS4wLjFailed", provider: "public-web", metadata: {} });
  const firstRun = database.beginRun("scheduled", null, 2);
  database.db.prepare("INSERT INTO audits(target_id,run_id,created_at,provider,status,warnings_json,message) VALUES(?,?,?,?,?,?,?)")
    .run(first.id, firstRun, new Date().toISOString(), "public-web", "validated", "[]", "完成");
  database.db.prepare("INSERT INTO audits(target_id,run_id,created_at,provider,status,warnings_json,message) VALUES(?,?,?,?,?,?,?)")
    .run(second.id, firstRun, new Date().toISOString(), "public-web", "rejected", "[]", "失败");
  database.finishRun(firstRun, { status: "partial", successCount: 1, errorCount: 1, processedCount: 2 });
  const retry = database.beginRun("scheduled", null, 1);
  database.saveCollection(first, retry, {
    capturedAt: new Date().toISOString(),
    snapshot: { followers: 8, totalLikes: 100, totalPosts: 1 },
    posts: [], qualityStatus: "validated", accountStatus: "available", worksCoverage: "limited",
    raw: { profile: { user: { sec_uid: first.locator, uid: "retry-first", follower_count: 8,
      total_favorited: 100, aweme_count: 1 } }, works: { aweme_list: [] },
      provenance: { mode: "scheduler-status-fixture", accountLocator: "sec_uid" } },
  });
  database.finishRun(retry, { status: "success", successCount: 1, errorCount: 0, processedCount: 1 });
  const scheduler = new MonitorScheduler(database);
  const state = scheduler.getStatus();
  assert.equal(state.scheduleState, "partial");
  assert.equal(state.scheduledTargetCount, 2);
  assert.equal(state.scheduledCompletedTargetCount, 1);
  assert.equal(state.scheduledPendingTargetCount, 1);
  assert.equal(state.scheduledExhaustedTargetCount, 0);
  assert.equal(state.scheduledManualTargetCount, 0);
});

test("deterministic identity conflicts stop automatic retries and stay visible as manual evidence", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-manual-evidence-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const target = database.createTarget({ type: "account", label: "身份冲突账号", locator: "MS4wLjConflict", provider: "public-web", metadata: {} });
  const runId = database.beginRun("scheduled", null, 1);
  database.db.prepare("INSERT INTO audits(target_id,run_id,created_at,provider,status,warnings_json,message) VALUES(?,?,?,?,?,?,?)")
    .run(target.id, runId, new Date().toISOString(), "public-web", "rejected", "[]", "公开主页回显身份不一致");
  database.finishRun(runId, { status: "error", successCount: 0, errorCount: 1, processedCount: 1 });
  const scheduler = new MonitorScheduler(database, { scheduledRetryDelaysMs: [1, 1, 1] });
  const state = scheduler.getStatus();
  assert.equal(state.scheduleState, "partial");
  assert.equal(state.scheduledManualTargetCount, 1);
  assert.equal(state.scheduledExhaustedTargetCount, 0);
  assert.equal(state.scheduledPendingTargetCount, 0);
  assert.deepEqual(scheduler.scheduledDueTargetIds(localDateKey(), new Date(Date.now() + 60_000)), []);
});

test("scheduled runs persist one anonymous source probe per local day", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-scheduled-probe-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.createTarget({ type: "account", label: "定时自检账号", locator: "MS4wLjProbe", provider: "public-web", metadata: {} });
  let probeCalls = 0;
  const execFileImpl = (_file, args, _options, callback) => {
    const operation = args[args.indexOf("--operation") + 1];
    if (operation === "selftest") {
      probeCalls += 1;
      return callback(null, JSON.stringify({ ok: true, data: {
        profileEndpoint: true, postsEndpoint: true, hotEndpoint: true,
        nickname: "林树（三角洲行动）", followerCount: 13_000_000, postCount: 1,
        mode: "scheduled-test", runtimeAI: false, paidAPI: false,
      } }), "");
    }
    callback(null, successfulAccountPayload("scheduled-probe-post"), "");
  };
  const scheduler = new MonitorScheduler(database, { scheduledSourceProbe: true, providerOptions: { execFileImpl, cooldownMs: 0 } });
  await scheduler.runAll({ triggerType: "scheduled" });
  await scheduler.runAll({ triggerType: "scheduled" });
  assert.equal(probeCalls, 1);
  const probe = database.getLatestSourceProbe("douyin-public");
  assert.equal(probe.ok, true);
  assert.equal(probe.result.mode, "scheduled-test");
  assert.equal(probe.result.runtimeAI, false);
  assert.equal(probe.trigger, "scheduled");
  assert.equal(Number.isFinite(probe.durationMs), true);
  assert.equal(probe.durationMs >= 0, true);
});

test("manual and first-collection runs do not trigger the daily platform probe", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scheduler-probe-trigger-"));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({ type: "account", label: "首采", locator: "MS4wLjFirstCollection", provider: "public-web" });
  const operations = [];
  const execFileImpl = (_file, args, _options, callback) => {
    operations.push(args[args.indexOf("--operation") + 1]);
    const payload = JSON.parse(successfulAccountPayload("first-collection-probe-test"));
    payload.data.profile.user.sec_uid = target.locator;
    payload.data.profile.user.unique_id = "first-collection-test";
    payload.data.profile.user.nickname = "首采";
    payload.data.works.aweme_list[0].author = { sec_uid: target.locator };
    callback(null, JSON.stringify(payload), "");
  };
  const scheduler = new MonitorScheduler(database, { scheduledSourceProbe: true, providerOptions: { execFileImpl, cooldownMs: 0 } });
  for (const triggerType of ["manual", "first-collection"]) {
    const result = await scheduler.runAll({ triggerType, targetId: target.id });
    assert.equal(result.successCount, 1);
  }
  assert.equal(operations.length, 2);
  assert.ok(!operations.includes("selftest"));
  assert.equal(database.getLatestSourceProbe("douyin-public"), null);
});

test("a failed manual source probe never suppresses the same-day scheduled probe", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-scheduled-probe-recovery-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.createTarget({ type: "account", label: "失败后重测账号", locator: "MS4wLjProbeRecovery", provider: "public-web", metadata: {} });
  database.recordSourceProbe("douyin-public", { ok: false, error: "手动自检超时", trigger: "manual" });
  let probeCalls = 0;
  const execFileImpl = (_file, args, _options, callback) => {
    const operation = args[args.indexOf("--operation") + 1];
    if (operation === "selftest") {
      probeCalls += 1;
      return callback(null, JSON.stringify({ ok: true, data: {
        profileEndpoint: true, postsEndpoint: true, hotEndpoint: true,
        nickname: "林树（三角洲行动）", followerCount: 13_000_000, postCount: 1,
        mode: "scheduled-recovery", runtimeAI: false, paidAPI: false,
      } }), "");
    }
    callback(null, successfulAccountPayload("scheduled-recovery-post"), "");
  };
  const scheduler = new MonitorScheduler(database, { scheduledSourceProbe: true, providerOptions: { execFileImpl, cooldownMs: 0 } });
  await scheduler.runAll({ triggerType: "scheduled" });
  assert.equal(probeCalls, 1);
  assert.equal(database.getLatestSourceProbe().trigger, "scheduled");
  assert.equal(database.getLatestSourceProbe().result.mode, "scheduled-recovery");
});

test("scheduled Douyin source probes do not run for a Bilibili-only batch", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-scheduled-probe-platform-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.createTarget({ type: "account", label: "B站账号", locator: "1809444890", provider: "public-web", metadata: { platform: "bilibili" } });
  let selftestCalls = 0;
  const execFileImpl = (_file, args, _options, callback) => {
    const operation = args[args.indexOf("--operation") + 1];
    if (operation === "selftest") selftestCalls += 1;
    callback(null, successfulAccountPayload("bilibili-post"), "");
  };
  const scheduler = new MonitorScheduler(database, {
    scheduledSourceProbe: true,
    providerOptions: {
      execFileImpl,
      cooldownMs: 0,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { card: { mid: "1809444890", name: "B站账号" } } }),
      }),
    },
  });
  await scheduler.runAll({ triggerType: "scheduled" });
  assert.equal(selftestCalls, 0);
  assert.equal(database.getLatestSourceProbe("douyin-public"), null);
  assert.equal(database.getLatestSourceProbe("bilibili-public").ok, true);
});

test("scheduler exposes live progress and persists it while a target is running", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-progress-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.createTarget({ type: "account", label: "进度账号", locator: "MS4wLjProgress", provider: "public-web", metadata: {} });
  let release;
  const called = new Promise((resolve) => {
    release = (callback) => resolve(callback);
  });
  const execFileImpl = (_file, _args, _options, callback) => release(callback);
  const scheduler = new MonitorScheduler(database, { providerOptions: { execFileImpl, cooldownMs: 0 } });
  const runPromise = scheduler.runAll({ triggerType: "scheduled" });
  const callback = await called;
  const live = scheduler.getStatus().currentRun;
  assert.equal(live.targetCount, 1);
  assert.equal(live.completedCount, 0);
  assert.equal(live.currentTarget.label, "进度账号");
  const persisted = database.getOverview().recentRuns[0];
  assert.equal(persisted.status, "running");
  assert.equal(persisted.processed_count, 0);
  callback(null, successfulAccountPayload("progress-post"), "");
  const result = await runPromise;
  assert.equal(result.status, "success");
  assert.equal(database.getOverview().recentRuns[0].processed_count, 1);
});

test("deleting a target during collection safely skips it and the batch still finishes", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-delete-race-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const first = database.createTarget({ type: "account", label: "将被删除", locator: "MS4wLjDelete", provider: "public-web", metadata: {} });
  database.createTarget({ type: "account", label: "继续执行", locator: "MS4wLjContinue", provider: "public-web", metadata: {} });
  let firstCallback;
  let callCount = 0;
  let runResult;
  let runError;
  let scheduler;
  const firstCalled = new Promise((resolve) => {
    const execFileImpl = (_file, _args, _options, callback) => {
      callCount += 1;
      if (callCount === 1) { firstCallback = callback; resolve(); return; }
      callback(null, successfulAccountPayload("continue-post"), "");
    };
    scheduler = new MonitorScheduler(database, { providerOptions: { execFileImpl, cooldownMs: 0 } });
    scheduler.runAll({ triggerType: "scheduled" }).then((result) => { runResult = result; }, (error) => { runError = error; });
  });
  await firstCalled;
  database.deleteTarget(first.id);
  firstCallback(null, successfulAccountPayload("deleted-post"), "");
  while (!runResult && !runError) await new Promise((resolve) => setImmediate(resolve));
  if (runError) throw runError;
  assert.equal(runResult.successCount, 1);
  assert.equal(runResult.skippedCount, 1);
  assert.equal(database.getOverview().recentRuns[0].status, "success");
});

test("a partial scheduled run retries only failed targets after the bounded backoff", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-partial-retry-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const stable = database.createTarget({ type: "account", label: "首次成功账号", locator: "MS4wLjStable", provider: "public-web", metadata: {} });
  const flaky = database.createTarget({ type: "account", label: "首次失败账号", locator: "MS4wLjFlaky", provider: "public-web", metadata: {} });
  const calls = new Map();
  const execFileImpl = (_file, args, _options, callback) => {
    const locator = args[args.indexOf("--locator") + 1];
    const attempt = (calls.get(locator) ?? 0) + 1;
    calls.set(locator, attempt);
    if (locator === flaky.locator && attempt === 1) return callback(new Error("temporary failure"), "", "");
    return callback(null, successfulAccountPayload(`${locator}-${attempt}`), "");
  };
  const scheduler = new MonitorScheduler(database, {
    providerOptions: { execFileImpl, cooldownMs: 0 },
    scheduledRetryDelaysMs: [1_000],
  });
  const firstTick = new Date();
  await scheduler.tick(firstTick);
  await scheduler.tick(new Date(firstTick.getTime() + 500));
  assert.equal(calls.get(stable.locator), 1);
  assert.equal(calls.get(flaky.locator), 1);

  await scheduler.tick(new Date(firstTick.getTime() + 1_500));
  assert.equal(calls.get(stable.locator), 1, "successful targets must not be collected again");
  assert.equal(calls.get(flaky.locator), 2, "the failed target should be retried once");
  const runs = database.db.prepare(`
    SELECT status,target_count,success_count,error_count FROM runs
    WHERE trigger_type='scheduled' ORDER BY id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(runs, [
    { status: "partial", target_count: 2, success_count: 1, error_count: 1 },
    { status: "success", target_count: 1, success_count: 1, error_count: 0 },
  ]);
});

test("scheduled retries stop after the configured same-day attempt limit", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-retry-limit-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  database.createTarget({ type: "account", label: "持续失败账号", locator: "MS4wLjAlwaysFail", provider: "public-web", metadata: {} });
  let calls = 0;
  const execFileImpl = (_file, _args, _options, callback) => {
    calls += 1;
    callback(new Error("temporary failure"), "", "");
  };
  const scheduler = new MonitorScheduler(database, {
    providerOptions: { execFileImpl, cooldownMs: 0 },
    scheduledRetryDelaysMs: [500, 1_000],
  });
  const firstTick = new Date();
  await scheduler.tick(firstTick);
  await scheduler.tick(new Date(firstTick.getTime() + 400));
  assert.equal(calls, 1, "retry must wait for its first backoff");
  await scheduler.tick(new Date(firstTick.getTime() + 600));
  await scheduler.tick(new Date(firstTick.getTime() + 1_200));
  await scheduler.tick(new Date(firstTick.getTime() + 60_000));

  assert.equal(calls, 3, "one initial attempt plus two configured retries");
  const statuses = database.db.prepare("SELECT status FROM runs WHERE trigger_type='scheduled' ORDER BY id").all().map((row) => row.status);
  assert.deepEqual(statuses, ["error", "error", "error"]);
});

test("retryable collection warnings are retried while public-window limitations count as completed", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-warning-retry-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const limited = database.createTarget({ type: "account", label: "公开窗口有限但有效", locator: "MS4wLjLimited", provider: "public-web", metadata: {} });
  const blocked = database.createTarget({ type: "account", label: "首次被 UIFID 阻断", locator: "MS4wLjBlocked", provider: "public-web", metadata: {} });
  const calls = new Map();
  const execFileImpl = (_file, args, _options, callback) => {
    const locator = args[args.indexOf("--locator") + 1];
    const attempt = (calls.get(locator) ?? 0) + 1;
    calls.set(locator, attempt);
    if (locator === limited.locator) {
      return callback(null, successfulAccountPayload("limited-post", ["匿名公开接口仅返回账号最新公开作品窗口；监控台会按日持续积累，未将当前窗口标为完整历史"]), "");
    }
    if (attempt === 1) {
      return callback(null, JSON.stringify({
        ok: true,
        data: {
          profile: { user: { follower_count: 8 } },
          works: { aweme_list: [] },
          warnings: ["作品列表接口未通过：公开网页请求失败（HTTP 403）：Blocked by ArgusSecurityPlugin Uifid Not Found"],
        },
      }), "");
    }
    return callback(null, successfulAccountPayload("recovered-post"), "");
  };
  const scheduler = new MonitorScheduler(database, {
    providerOptions: { execFileImpl, cooldownMs: 0 },
    scheduledRetryDelaysMs: [1_000],
  });
  const firstTick = new Date();
  await scheduler.tick(firstTick);
  const firstResult = database.getOverview().recentRuns[0];
  assert.equal(firstResult.status, "partial");
  assert.equal(firstResult.success_count, 1);
  assert.equal(firstResult.error_count, 1);
  assert.equal(firstResult.warning_count, 2);
  assert.equal(firstResult.details.find((item) => item.targetId === limited.id).reviewState, "limited");
  assert.equal(firstResult.details.find((item) => item.targetId === blocked.id).reviewState, "retry");

  await scheduler.tick(new Date(firstTick.getTime() + 1_500));
  assert.equal(calls.get(limited.locator), 1, "a valid limited public window must not be collected twice");
  assert.equal(calls.get(blocked.locator), 2, "the UIFID-blocked target must be retried");
  const recovered = database.getOverview().recentRuns[0].details.find(item => item.targetId === blocked.id);
  assert.equal(recovered.reviewState, "limited", "returned sample remains useful but is not a complete work inventory");
  const runs = database.db.prepare(`
    SELECT status,target_count,success_count,error_count,warning_count FROM runs
    WHERE trigger_type='scheduled' ORDER BY id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(runs, [
    { status: "partial", target_count: 2, success_count: 1, error_count: 1, warning_count: 2 },
    { status: "success", target_count: 1, success_count: 1, error_count: 0, warning_count: 1 },
  ]);
});

test("a warning audit cannot reopen a saved limited snapshot as an exhausted retry", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-saved-coverage-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const target = database.createTarget({ type: "account", label: "已有公开窗口", locator: "MS4wLjSavedLimited", provider: "public-web", metadata: {} });
  const runId = database.beginRun("scheduled", null, 1);
  database.saveCollection(target, runId, {
    capturedAt: new Date().toISOString(),
    snapshot: { followers: 8, totalLikes: 100, totalPosts: 1 },
    posts: [],
    warnings: ["本次响应未识别到作品列表；未用 0 覆盖历史数据"],
    qualityStatus: "warning",
    accountStatus: "available",
    worksCoverage: "limited",
    raw: { profile: { user: { aweme_count: 1 } }, works: { aweme_list: [] }, provenance: { worksScope: "latest-public-window" } },
  });
  database.finishRun(runId, { status: "success", successCount: 1, warningCount: 1, processedCount: 1 });
  const scheduler = new MonitorScheduler(database);
  const plan = scheduler.scheduledPlanSummary(localDateKey(new Date()));
  assert.equal(plan.completedCount, 1);
  assert.equal(plan.exhaustedCount, 0);
  assert.equal(plan.pendingCount, 0);
});

test("daily profile completion is separate from a works HTTP 403 and is deferred until tomorrow", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-profile-403-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const target = database.createTarget({ type: "account", label: "主页指标已完成", locator: "MS4wLjProfile403", provider: "public-web", metadata: {} });
  const runId = database.beginRun("scheduled", null, 1);
  database.saveCollection(target, runId, {
    capturedAt: new Date().toISOString(),
    snapshot: { followers: 100, totalLikes: 200, totalPosts: 3 },
    posts: [],
    warnings: ["作品列表接口未通过：公开网页请求失败（HTTP 403）；未用空数据覆盖历史作品"],
    qualityStatus: "warning",
    accountStatus: "available",
    worksCoverage: "unavailable",
    worksError: "公开网页请求失败（HTTP 403）",
    raw: { profile: { user: { follower_count: 100, total_favorited: 200, aweme_count: 3 } }, works: { error: "HTTP 403" } },
  });
  database.finishRun(runId, { status: "success", successCount: 1, warningCount: 1, processedCount: 1 });
  const scheduler = new MonitorScheduler(database, { scheduledRetryDelaysMs: [0, 0] });
  const plan = scheduler.scheduledPlanSummary(localDateKey(new Date()));
  assert.equal(plan.completedCount, 0, "completedCount keeps its existing works-review meaning");
  assert.equal(plan.profileCompletedCount, 1);
  assert.equal(plan.worksRetryCount, 1);
  assert.equal(plan.worksDeferredCount, 1);
  assert.equal(plan.pendingCount, 0, "an intentional works deferral is not a generic pending retry");
  assert.equal(plan.exhaustedCount, 0, "an intentional works deferral is not an exhausted retry");
  assert.deepEqual(scheduler.scheduledDueTargetIds(localDateKey(), new Date(Date.now() + 60_000)), []);
  const status = scheduler.getStatus();
  assert.equal(status.scheduledProfileCompletedTargetCount, 1);
  assert.equal(status.scheduledWorksDeferredTargetCount, 1);
});

test("missing homepage counters remain pending even when the works endpoint is blocked", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-profile-missing-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const target = database.createTarget({ type: "account", label: "主页指标缺失", locator: "MS4wLjProfileMissing", provider: "public-web", metadata: {} });
  const runId = database.beginRun("scheduled", null, 1);
  database.saveCollection(target, runId, {
    capturedAt: new Date().toISOString(),
    snapshot: { followers: 100, totalLikes: null, totalPosts: 3 },
    posts: [],
    warnings: ["作品列表接口未通过：公开网页请求失败（HTTP 403）"],
    qualityStatus: "warning",
    accountStatus: "partial",
    worksCoverage: "unavailable",
    worksError: "公开网页请求失败（HTTP 403）",
    raw: { profile: { user: { follower_count: 100, aweme_count: 3 } }, works: { error: "HTTP 403" } },
  });
  database.finishRun(runId, { status: "partial", successCount: 1, errorCount: 0, warningCount: 1, processedCount: 1 });
  const scheduler = new MonitorScheduler(database, { scheduledRetryDelaysMs: [0, 0, 0] });
  const plan = scheduler.scheduledPlanSummary(localDateKey(new Date()));
  assert.equal(plan.profileCompletedCount, 0);
  assert.equal(plan.completedCount, 0);
  assert.equal(plan.pendingCount, 1);
  assert.deepEqual(scheduler.scheduledDueTargetIds(localDateKey(), new Date(Date.now() + 60_000)), [target.id]);
});

test("a latest same-day failure cannot borrow an older profile snapshot to defer the target", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-latest-failure-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const target = database.createTarget({ type: "account", label: "最新失败不能借旧快照", locator: "MS4wLjLatestFailure", provider: "public-web", metadata: {} });
  const successfulRun = database.beginRun("scheduled", null, 1);
  database.saveCollection(target, successfulRun, {
    capturedAt: new Date(Date.now() - 2_000).toISOString(),
    snapshot: { followers: 100, totalLikes: 200, totalPosts: 3 },
    posts: [],
    warnings: ["作品列表接口未通过：公开网页请求失败（HTTP 403）；未用空数据覆盖历史作品"],
    qualityStatus: "warning",
    accountStatus: "available",
    worksCoverage: "unavailable",
    worksError: "公开网页请求失败（HTTP 403）",
    raw: { profile: { user: { follower_count: 100, total_favorited: 200, aweme_count: 3 } }, works: { error: "HTTP 403" } },
  });
  database.finishRun(successfulRun, { status: "success", successCount: 1, warningCount: 1, processedCount: 1 });
  const failedRun = database.beginRun("scheduled", null, 1);
  database.recordFailure(target, failedRun, new Error("最新主页请求失败（HTTP 502）"));
  database.finishRun(failedRun, { status: "error", errorCount: 1, processedCount: 1 });

  const scheduler = new MonitorScheduler(database, { scheduledRetryDelaysMs: [0, 0, 0] });
  const dateKey = localDateKey(new Date());
  const plan = scheduler.scheduledPlanSummary(dateKey);
  assert.equal(plan.profileCompletedCount, 0, "the latest failed audit has no profile completion evidence");
  assert.equal(plan.worksDeferredCount, 0, "an old 403 snapshot must not defer today's latest failure");
  assert.equal(plan.pendingCount, 1);
  assert.deepEqual(scheduler.scheduledDueTargetIds(dateKey, new Date(Date.now() + 60_000)), [target.id]);
});

test("scheduled counters expose account denominator, profile pending and topic metric completion", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-counters-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const account = database.createTarget({ type: "account", label: "主页已完成", locator: "MS4wLjCounterAccount", provider: "public-web", metadata: {} });
  const pending = database.createTarget({ type: "account", label: "主页待采集", locator: "MS4wLjCounterPending", provider: "public-web", metadata: {} });
  const topic = database.createTarget({ type: "hashtag", label: "#计数话题", locator: "#计数话题", provider: "public-web", metadata: {} });
  const incompleteTopic = database.createTarget({ type: "hashtag", label: "#缺少播放量", locator: "#缺少播放量", provider: "public-web", metadata: {} });
  const zeroTopic = database.createTarget({ type: "hashtag", label: "#真实零值", locator: "#真实零值", provider: "public-web", metadata: {} });
  const runId = database.beginRun("scheduled", null, 4);
  database.saveCollection(account, runId, {
    capturedAt: new Date().toISOString(), snapshot: { followers: 10, totalLikes: 20, totalPosts: 2 },
    posts: [], qualityStatus: "validated", accountStatus: "available", worksCoverage: "complete", raw: {},
  });
  database.saveCollection(topic, runId, {
    capturedAt: new Date().toISOString(), snapshot: { hashtagParticipants: 30, hashtagViews: 400 },
    posts: [], qualityStatus: "validated", raw: {},
  });
  database.saveCollection(incompleteTopic, runId, {
    capturedAt: new Date().toISOString(), snapshot: { hashtagParticipants: 12, hashtagViews: null },
    posts: [], qualityStatus: "warning", raw: {},
  });
  database.saveCollection(zeroTopic, runId, {
    capturedAt: new Date().toISOString(), snapshot: { hashtagParticipants: 0, hashtagViews: 0 },
    posts: [], qualityStatus: "validated", raw: {},
  });
  database.finishRun(runId, { status: "success", successCount: 3, warningCount: 1, processedCount: 4 });

  const scheduler = new MonitorScheduler(database);
  const plan = scheduler.scheduledPlanSummary(localDateKey(new Date()));
  assert.equal(plan.scheduledAccountTargetCount, 2);
  assert.equal(plan.scheduledProfilePendingTargetCount, 1);
  assert.equal(plan.scheduledMetricCompletedTargetCount, 3, "one account plus two complete topics has complete daily metrics");
  assert.equal(plan.scheduledTopicTargetCount, 3, "the topic denominator excludes both account targets");
  assert.equal(plan.scheduledTopicMetricCompletedTargetCount, 2, "both real metrics count when present, including genuine zero values");
  const status = scheduler.getStatus();
  assert.equal(status.scheduledAccountTargetCount, 2);
  assert.equal(status.scheduledProfilePendingTargetCount, 1);
  assert.equal(status.scheduledMetricCompletedTargetCount, 3);
  assert.equal(status.scheduledTopicTargetCount, 3);
  assert.equal(status.scheduledTopicMetricCompletedTargetCount, 2);
  // The plan fields above are the durable source; getStatus exposes the same
  // denominators for the UI status panel.
  const latest = database.lastScheduledRun();
  assert.equal(latest.id, runId);
});

test("scheduled day matching can be pinned to the Beijing business timezone", (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-business-day-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const target = database.createTarget({ type: "account", label: "北京时间边界", locator: "MS4wLjBusinessDay", provider: "public-web", metadata: {} });
  const capturedAt = "2026-09-21T00:30:00.000Z"; // 09-21 08:30 Asia/Shanghai, 09-20 in Los Angeles
  const runId = database.beginRun("scheduled", null, 1);
  database.saveCollection(target, runId, {
    capturedAt,
    snapshot: { followers: 1, totalLikes: 2, totalPosts: 3 },
    posts: [], qualityStatus: "validated", accountStatus: "available", worksCoverage: "complete", raw: {},
  });
  database.finishRun(runId, { status: "success", successCount: 1, processedCount: 1 });
  database.db.prepare("UPDATE runs SET started_at=?,finished_at=? WHERE id=?").run(capturedAt, "2026-09-21T00:30:02.000Z", runId);
  database.db.prepare("UPDATE audits SET created_at=? WHERE run_id=?").run("2026-09-21T00:30:01.000Z", runId);
  const scheduler = new MonitorScheduler(database, { scheduleTimeZone: "Asia/Shanghai" });
  assert.equal(scheduler.scheduledPlanSummary("2026-09-21").profileCompletedCount, 1);
  assert.equal(scheduler.scheduledPlanSummary("2026-09-20").profileCompletedCount, 0);
});

test("a target added after today's successful run receives an automatic first collection", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-new-target-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const existing = database.createTarget({ type: "account", label: "今日已采集", locator: "MS4wLjExisting", provider: "public-web", metadata: {} });
  const calls = new Map();
  const execFileImpl = (_file, args, _options, callback) => {
    const locator = args[args.indexOf("--locator") + 1];
    calls.set(locator, (calls.get(locator) ?? 0) + 1);
    callback(null, successfulAccountPayload(`${locator}-post`), "");
  };
  const scheduler = new MonitorScheduler(database, { providerOptions: { execFileImpl, cooldownMs: 0 } });
  const now = new Date();
  await scheduler.tick(now);
  const added = database.createTarget({ type: "account", label: "刚从表格新增", locator: "MS4wLjNew", provider: "public-web", metadata: {} });
  await scheduler.tick(new Date(now.getTime() + 30_000));

  assert.equal(calls.get(existing.locator), 1, "today's completed target must not be collected again");
  assert.equal(calls.get(added.locator), 1, "the newly added target must not wait until tomorrow");
  const runs = database.db.prepare(`
    SELECT status,target_count,success_count,error_count FROM runs
    WHERE trigger_type='scheduled' ORDER BY id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(runs, [
    { status: "success", target_count: 1, success_count: 1, error_count: 0 },
    { status: "success", target_count: 1, success_count: 1, error_count: 0 },
  ]);
});

test("the first verified public collection replaces a generated placeholder with the real author name", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-auto-label-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const secUid = "MS4wLjABAAAAabcdefghijklmnopqrstuvwx";
  const target = database.createTarget({
    type: "account",
    label: "抖音作者 · 占位",
    locator: secUid,
    provider: "public-web",
    metadata: { platform: "douyin", autoLabelPending: true },
  });
  const execFileImpl = (_file, _args, _options, callback) => callback(null, JSON.stringify({ ok: true, data: {
    profile: { user: { sec_uid: secUid, nickname: "公开核验作者", follower_count: 8, total_favorited: 100 } },
    works: { aweme_list: [{ aweme_id: "verified-name-post", author: { sec_uid: secUid, nickname: "公开核验作者" }, statistics: { digg_count: 5 } }] },
  } }), "");
  const scheduler = new MonitorScheduler(database, { providerOptions: { execFileImpl, cooldownMs: 0 } });
  const result = await scheduler.runAll({ triggerType: "test", targetId: target.id });
  assert.equal(result.status, "success");
  const updated = database.getTarget(target.id);
  assert.equal(updated.label, "公开核验作者");
  assert.equal(updated.metadata.autoLabelPending, undefined);
  assert.equal(updated.metadata.identityVerification.accountId, secUid);
});

test("verified public names stay synchronized while a submitted-name mismatch warns only once", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-name-verification-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  const secUid = "MS4wLjABAAAAnameVerificationabcdefghijklmnop";
  const target = database.createTarget({
    type: "account",
    label: "表格里的错误名称",
    locator: secUid,
    provider: "public-web",
    metadata: { platform: "douyin", submittedName: "表格里的错误名称" },
  });
  const observedNames = ["主页真实作者", "主页真实作者", "表格里的错误名称", "后续公开昵称"];
  let collectionIndex = 0;
  const execFileImpl = (_file, _args, _options, callback) => {
    const observedName = observedNames[Math.min(collectionIndex, observedNames.length - 1)];
    const capturedAt = new Date(Date.UTC(2026, 8, 7, 10, 0, collectionIndex)).toISOString();
    collectionIndex += 1;
    callback(null, JSON.stringify({ ok: true, data: {
      capturedAt,
      profile: { user: { sec_uid: secUid, nickname: observedName, follower_count: 8, total_favorited: 100 } },
      works: { aweme_list: [{ aweme_id: "verified-name-mismatch-post", author: { sec_uid: secUid, nickname: observedName }, statistics: { digg_count: 5 } }] },
    } }), "");
  };
  const scheduler = new MonitorScheduler(database, { providerOptions: { execFileImpl, cooldownMs: 0 } });
  const first = await scheduler.runAll({ triggerType: "test", targetId: target.id });
  assert.equal(first.status, "success");
  assert.match(first.details[0].warnings.join("；"), /表格作者名称.*主页真实作者.*更正/);
  let updated = database.getTarget(target.id);
  assert.equal(updated.label, "主页真实作者");
  assert.equal(updated.metadata.submittedName, "表格里的错误名称");
  assert.equal(updated.metadata.nameVerification.status, "corrected");
  assert.equal(updated.metadata.nameVerification.observedName, "主页真实作者");
  assert.ok(updated.metadata.nameVerification.firstMismatchAt);

  const second = await scheduler.runAll({ triggerType: "test", targetId: target.id });
  assert.doesNotMatch(second.details[0].warnings.join("；"), /表格作者名称/);
  assert.equal(database.getTarget(target.id).label, "主页真实作者");

  const third = await scheduler.runAll({ triggerType: "test", targetId: target.id });
  assert.doesNotMatch(third.details[0].warnings.join("；"), /表格作者名称/);
  updated = database.getTarget(target.id);
  assert.equal(updated.label, "表格里的错误名称");
  assert.equal(updated.metadata.nameVerification.status, "matched");
  assert.equal(updated.metadata.nameVerification.observedName, "表格里的错误名称");

  const fourth = await scheduler.runAll({ triggerType: "test", targetId: target.id });
  assert.doesNotMatch(fourth.details[0].warnings.join("；"), /表格作者名称/);
  updated = database.getTarget(target.id);
  assert.equal(updated.label, "后续公开昵称");
  assert.equal(updated.metadata.nameVerification.status, "corrected");
  assert.equal(updated.metadata.nameVerification.observedName, "后续公开昵称");
  assert.ok(updated.metadata.nameVerification.firstMismatchAt);

  const audits = database.listTargetAudits(target.id, 5);
  assert.equal(audits.filter((audit) => /表格作者名称/.test(audit.warnings.join("；"))).length, 1);
});

test("new targets keep their own retry budget after another target exhausted its attempts", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-per-target-budget-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "00:00" });
  const exhausted = database.createTarget({ type: "account", label: "已耗尽补采", locator: "MS4wLjExhausted", provider: "public-web", metadata: {} });
  const calls = new Map();
  const execFileImpl = (_file, args, _options, callback) => {
    const locator = args[args.indexOf("--locator") + 1];
    calls.set(locator, (calls.get(locator) ?? 0) + 1);
    callback(new Error("temporary failure"), "", "");
  };
  const scheduler = new MonitorScheduler(database, {
    providerOptions: { execFileImpl, cooldownMs: 0 },
    scheduledRetryDelaysMs: [0],
  });
  const now = new Date();
  await scheduler.tick(now);
  await scheduler.tick(new Date(now.getTime() + 1_000));
  await scheduler.tick(new Date(now.getTime() + 2_000));
  assert.equal(calls.get(exhausted.locator), 2, "the original target must stop after its own attempt limit");

  const fresh = database.createTarget({ type: "account", label: "新加入目标", locator: "MS4wLjFresh", provider: "public-web", metadata: {} });
  await scheduler.tick(new Date(now.getTime() + 3_000));
  await scheduler.tick(new Date(now.getTime() + 4_000));
  await scheduler.tick(new Date(now.getTime() + 5_000));
  assert.equal(calls.get(exhausted.locator), 2, "adding a target must not revive an exhausted target");
  assert.equal(calls.get(fresh.locator), 2, "the new target must receive an initial attempt and its own retry");
});

test("an interrupted scheduled run resumes only targets not already audited that day", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-resume-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, "test.sqlite");
  const firstDatabase = new MonitorDatabase(filePath);
  firstDatabase.setSettings({ scheduleTime: "00:00" });
  const completedTarget = firstDatabase.createTarget({ type: "account", label: "已完成账号", locator: "MS4wLjDone", provider: "public-web", metadata: {} });
  const pendingTarget = firstDatabase.createTarget({ type: "account", label: "待恢复账号", locator: "MS4wLjPending", provider: "public-web", metadata: {} });
  const interruptedRunId = firstDatabase.beginRun("scheduled", null, 2);
  firstDatabase.saveCollection(completedTarget, interruptedRunId, {
    capturedAt: new Date().toISOString(),
    snapshot: { followers: 8 },
    posts: [],
    warnings: [],
    qualityStatus: "validated",
    raw: {},
  });
  firstDatabase.updateRunProgress(interruptedRunId, { processedCount: 1, successCount: 1 });
  firstDatabase.close();

  const database = new MonitorDatabase(filePath);
  t.after(() => database.close());
  assert.equal(database.recoverInterruptedRuns(), 1);
  let collectionCalls = 0;
  const execFileImpl = (_file, _args, _options, callback) => {
    collectionCalls += 1;
    callback(null, successfulAccountPayload("resumed-post"), "");
  };
  const scheduler = new MonitorScheduler(database, { providerOptions: { execFileImpl, cooldownMs: 0 } });
  await scheduler.tick(new Date());
  await scheduler.tick(new Date());

  assert.equal(collectionCalls, 1);
  const snapshotCounts = database.db.prepare(`
    SELECT target_id,COUNT(*) AS count FROM snapshots GROUP BY target_id ORDER BY target_id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(snapshotCounts, [
    { target_id: completedTarget.id, count: 1 },
    { target_id: pendingTarget.id, count: 1 },
  ]);
  const scheduledRuns = database.db.prepare(`
    SELECT status,processed_count,target_count FROM runs WHERE trigger_type='scheduled' ORDER BY id
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(scheduledRuns, [
    { status: "interrupted", processed_count: 1, target_count: 2 },
    { status: "success", processed_count: 1, target_count: 1 },
  ]);
});

test("a completed scheduled run invokes the durable completion hook exactly once", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-schedule-hook-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.createTarget({ type: "account", label: "手动目标", locator: "MANUAL", provider: "manual", metadata: {} });
  const completions = [];
  const scheduler = new MonitorScheduler(database, { onRunComplete: async (result) => completions.push(result) });
  const result = await scheduler.runAll({ triggerType: "scheduled" });
  assert.equal(result.status, "success");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].runId, result.runId);
  assert.equal(completions[0].triggerType, "scheduled");
});

test("wake-up coalesces missed calendar days into one current-day collection without inventing history", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "douyin-monitor-wake-catchup-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(tempDir, "test.sqlite"));
  t.after(() => database.close());
  database.setSettings({ scheduleTime: "10:00" });
  database.createTarget({ type: "account", label: "手动目标", locator: "MANUAL", provider: "manual", metadata: {} });
  const oldRunId = database.beginRun("scheduled", null, 1);
  database.finishRun(oldRunId, { status: "success", skippedCount: 1, processedCount: 1 });
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  database.db.prepare("UPDATE runs SET started_at=?,finished_at=? WHERE id=?").run(twoDaysAgo.toISOString(), twoDaysAgo.toISOString(), oldRunId);
  const scheduler = new MonitorScheduler(database);

  const wakeBeforeTodaySchedule = new Date();
  wakeBeforeTodaySchedule.setHours(8, 0, 0, 0);
  await scheduler.tick(wakeBeforeTodaySchedule);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE trigger_type='scheduled'").get().count, 1);
  const wakeAfterTodaySchedule = new Date();
  wakeAfterTodaySchedule.setHours(10, 5, 0, 0);
  await scheduler.tick(wakeAfterTodaySchedule);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE trigger_type='scheduled'").get().count, 2);
});

test('continuous scheduling yields an idle turn to identity resolution, then resumes unchanged',async t=>{
 const database=new MonitorDatabase(':memory:'); t.after(()=>database.close());
 database.createTarget({type:'account',label:'轮换账号',locator:'MS4wLjFairYield',provider:'public-web'});
 let reserved=true,collections=0;
 const scheduler=new MonitorScheduler(database,{continuousWindow:{key:'continuous:test',startsAt:'2026-10-26T00:00:00.000Z',endsAt:null},
   shouldYieldScheduledCollection:()=>reserved});
 scheduler.scheduledDueTargetIds=()=>[database.listTargets()[0].id];
 scheduler.runAll=async()=>{collections++;};
 await scheduler.tick(new Date('2026-10-26T12:00:00.000Z'));
 assert.equal(collections,0); assert.equal(scheduler.tickCount,1);
 reserved=false;
 await scheduler.tick(new Date('2026-10-26T12:00:01.000Z'));
 assert.equal(collections,1);
 assert.equal(database.db.prepare('select count(*) n from snapshots').get().n,0);
});
