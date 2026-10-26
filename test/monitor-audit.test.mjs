import test from "node:test";
import assert from "node:assert/strict";
import { buildVerdict, latestFreshness, parseLaunchdPrint } from "../scripts/audit-monitor-chain.mjs";
import { probeSources } from "../scripts/probe-public-sources.mjs";

test("monitor audit preserves a zero-minute launchd schedule", () => {
  const parsed = parseLaunchdPrint('state = not running\nruns = 14\nlast exit code = 0\n"Hour" => 10\n"Minute" => 0');
  assert.equal(parsed.scheduleHour, 10);
  assert.equal(parsed.scheduleMinute, 0);
});

test("monitor audit permits yesterday's snapshot only before today's schedule", () => {
  const before = latestFreshness("2026-09-09 10:05", 10, 0, new Date("2026-09-10T09:59:00"));
  const after = latestFreshness("2026-09-09 10:05", 10, 0, new Date("2026-09-10T10:01:00"));
  assert.equal(before.fresh, true);
  assert.equal(after.fresh, false);
});

test("monitor audit requires a completed original run and a clean command-center audit", () => {
  const original = {
    plist: { available: true },
    launchd: { available: true, lastExitCode: 0 },
    latest: { available: true, targetCount: 116, successCount: 110, failureCount: 6, freshness: { fresh: true } },
  };
  const commandCenter = {
    available: true,
    ok: true,
    runtimeAI: false,
    paidAPI: false,
    browserCollection: false,
    scheduler: { scheduleState: "completed" },
    database: { status: "ok", dataQuality: { status: "ok", violationCount: 0 } },
  };
  assert.deepEqual(buildVerdict(original, commandCenter), {
    originalJixuan: true,
    commandCenter: true,
    noBrowserCollection: true,
    noRuntimeAI: true,
    noPaidApi: true,
    sourceStatus: null,
    overall: true,
  });
});

test("monitor audit rejects a stale run or a dirty data contract", () => {
  const original = {
    plist: { available: true },
    launchd: { available: true, lastExitCode: 0 },
    latest: { available: true, targetCount: 116, successCount: 110, failureCount: 6, freshness: { fresh: true } },
  };
  const dirty = {
    available: true,
    ok: true,
    runtimeAI: false,
    paidAPI: false,
    browserCollection: false,
    scheduler: { scheduleState: "completed" },
    database: { status: "ok", dataQuality: { status: "error", violationCount: 1 } },
  };
  assert.equal(buildVerdict(original, dirty).overall, false);
  assert.equal(buildVerdict({ ...original, launchd: { available: true, lastExitCode: 1 } }, dirty).originalJixuan, false);
});

test("monitor audit rejects a failed automatic batch even when storage is clean", () => {
  const original = {
    plist: { available: true },
    launchd: { available: true, lastExitCode: 0 },
    latest: { available: true, targetCount: 116, successCount: 116, failureCount: 0, freshness: { fresh: true } },
  };
  const commandCenter = {
    available: true,
    ok: false,
    runtimeAI: false,
    paidAPI: false,
    browserCollection: false,
    scheduler: { scheduleState: "failed" },
    database: { status: "ok", dataQuality: { status: "ok", violationCount: 0 } },
  };
  assert.equal(buildVerdict(original, commandCenter).commandCenter, false);
  assert.equal(buildVerdict(original, commandCenter).overall, false);
});

test("monitor audit does not report green when the public works endpoint is degraded", () => {
  const original = {
    plist: { available: true }, launchd: { available: true, lastExitCode: 0 },
    latest: { available: true, targetCount: 1, successCount: 1, failureCount: 0, freshness: { fresh: true } },
  };
  const commandCenter = {
    available: true, ok: false, runtimeAI: false, paidAPI: false, browserCollection: false,
    sourceStatus: "degraded", scheduler: { scheduleState: "completed" },
    database: { status: "ok", dataQuality: { status: "ok", violationCount: 0 } },
  };
  const verdict = buildVerdict(original, commandCenter);
  assert.equal(verdict.sourceStatus, "degraded");
  assert.equal(verdict.commandCenter, false);
  assert.equal(verdict.overall, false);
});

test("public source audit keeps platform results separate and rejects paid-api claims", async () => {
  const result = await probeSources({
    testConnection: async () => ({ mode: "douyin-test", profileEndpoint: true, postsEndpoint: true, runtimeAI: false, paidAPI: false, nickname: "抖音" }),
    testConnectionForPlatform: async (platform) => ({ mode: `${platform}-test`, profileEndpoint: true, postsEndpoint: true, runtimeAI: false, paidAPI: platform === "bilibili" }),
  }, [
    { platform: "douyin", target: { locator: "sec" } },
    { platform: "bilibili", target: { locator: "uid" } },
  ]);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].platform, "douyin");
  assert.equal(result.results[1].platform, "bilibili");
  assert.equal(result.overall, false);
});
