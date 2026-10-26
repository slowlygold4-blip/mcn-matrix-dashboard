import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { MonitorScheduler } from "../lib/scheduler.mjs";
import { deriveCollectionHealth } from "../lib/collection-health.mjs";
import { normalizeCollection } from "../lib/providers/normalize.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";
import { checksum } from "../lib/utils.mjs";

const SEC_UID = "MS4wLjABAAAAcoverage_contract_abcdefghijklmnop";
const account = { id: 1, type: "account", label: "覆盖契约", locator: SEC_UID,
  provider: "public-web", metadata: { platform: "douyin" } };

function payload(coverage, { totalPosts = 100, postCount = 0, warnings = [] } = {}) {
  return {
    capturedAt: "2026-09-13T02:00:00.000Z", accountStatus: "validated",
    profile: { user: { sec_uid: SEC_UID, uid: "1234567890123", nickname: account.label,
      follower_count: 123, total_favorited: 456, aweme_count: totalPosts } },
    worksCoverage: coverage,
    works: { aweme_list: Array.from({ length: postCount }, (_, index) => ({
      aweme_id: `700000000000000000${index}`, create_time: 1789257600,
      author: { sec_uid: SEC_UID, uid: "1234567890123" }, statistics: { digg_count: 10 },
    })) },
    warnings,
    provenance: { worksCoverage: coverage, runtimeAI: false, paidAPI: false, cookiePersisted: false },
  };
}

function providerFor(raw) {
  let calls = 0;
  const provider = new PublicWebProvider({ publicPostsPerAccount: "30" }, {
    execFileImpl: (_file, args, _options, callback) => {
      calls += 1;
      assert.equal(args[args.indexOf("--operation") + 1], "account");
      callback(null, JSON.stringify({ ok: true, data: raw }), "");
    },
    fetchImpl: () => { throw new Error("network access is forbidden in coverage contract tests"); },
  });
  return { provider, callCount: () => calls };
}

const cases = [
  { name: "explicit complete empty response with an official zero inventory", coverage: "complete", totalPosts: 0 },
  { name: "local limit with valid returned works", coverage: "limited", postCount: 2,
    warnings: ["公开作品达到本地限额；不是完整历史"] },
  { name: "missing works array with a nonzero profile inventory", coverage: "retry", totalPosts: 100,
    warnings: ["作品列表接口未通过：响应缺少作品数组"] },
  { name: "missing works array even when the official profile inventory is zero", coverage: "retry", totalPosts: 0,
    warnings: ["作品列表接口未通过：响应缺少作品数组"] },
  { name: "missing works and unknown profile inventory", coverage: "retry", totalPosts: null,
    warnings: ["作品列表接口未通过：响应缺少作品数组"] },
  { name: "later page failure after retaining valid works", coverage: "unavailable", postCount: 1,
    warnings: ["作品列表接口未通过：HTTP 403"] },
  { name: "anonymous limited window takes precedence over legacy retry text", coverage: "latest-public-window", expected: "limited",
    warnings: ["本次响应未识别到作品列表；未用 0 覆盖历史数据"] },
];

for (const scenario of cases) {
  test(`explicit works coverage survives normalization and public provider: ${scenario.name}`, async () => {
    const raw = payload(scenario.coverage, scenario);
    const expected = scenario.expected ?? scenario.coverage;
    const normalized = normalizeCollection(account, raw);
    assert.equal(normalized.worksCoverage, expected);
    assert.equal(normalized.accountStatus, "available");
    assert.equal(normalized.snapshot.followers, 123);
    assert.equal(normalized.snapshot.totalLikes, 456);
    assert.equal(normalized.snapshot.totalPosts, scenario.totalPosts === undefined ? 100 : scenario.totalPosts);
    const { provider, callCount } = providerFor(raw);
    const result = await provider.collect(account);
    assert.equal(callCount(), 1, "coverage problems must not trigger an extra identity or browser request");
    assert.equal(result.worksCoverage, expected);
    assert.equal(result.accountStatus, "available");
    assert.deepEqual(result.snapshot, normalized.snapshot);
    assert.equal(result.posts.length, scenario.postCount ?? 0);
    assert.deepEqual(result.raw, raw, "the provider retains the complete collector envelope");
    assert.equal(result.sourceChecksum, checksum(raw));
  });
}

test("explicit retry from provenance is not promoted by an empty array, zero total, or old limited warning", () => {
  const raw = payload("retry", { totalPosts: 0, warnings: ["匿名公开接口仅返回账号最新公开作品窗口"] });
  delete raw.worksCoverage;
  const result = normalizeCollection(account, raw);
  assert.equal(result.worksCoverage, "retry");
  assert.equal(result.accountStatus, "available");
  assert.equal(deriveCollectionHealth(account, result.snapshot, result.warnings, raw).worksCoverage, "retry");
});

test("explicit limited and retry survive two database reopenings and board edits without invoking legacy repair", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "publication-coverage-contract-"));
  const filePath = join(directory, "fixture.sqlite");
  let database = new MonitorDatabase(filePath);
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget(account);
  for (const [index, scenario] of cases.entries()) {
    const raw = payload(scenario.coverage, scenario);
    raw.capturedAt = `2026-09-13T02:0${index}:00.000Z`;
    const collection = await providerFor(raw).provider.collect(target);
    const runId = database.beginRun("manual", target.id, 1);
    database.saveCollection(target, runId, collection);
    database.finishRun(runId, { status: "success", successCount: 1 });
  }
  const readHistory = () => Object.fromEntries(["snapshots", "posts", "post_metrics"]
    .map((table) => [table, database.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const original = readHistory();
  assert.deepEqual(original.snapshots.map((row) => row.works_coverage), cases.map((scenario) => scenario.expected ?? scenario.coverage));
  assert.ok(original.snapshots.every((row) => row.followers === 123 && row.total_likes === 456));
  assert.ok(original.snapshots.every((row) => checksum(JSON.parse(row.raw_json)) === row.source_checksum));
  // Legacy repair is deliberately opt-in. This guard fails if a future
  // startup/board path accidentally reintroduces it, even for zero totals.
  const legacyRepair = MonitorDatabase.prototype.repairStoredWorksCoverage;
  MonitorDatabase.prototype.repairStoredWorksCoverage = () => { throw new Error("legacy repair must not run during normal use"); };
  try {
    database.close();
    database = new MonitorDatabase(filePath);
    assert.deepEqual(readHistory(), original);
    database.createBoard("覆盖保全核对");
    database.assignTargetsToBoard([target.id], "覆盖保全核对");
    assert.deepEqual(readHistory(), original);
    database.close();
    database = new MonitorDatabase(filePath);
    assert.deepEqual(readHistory(), original);
  } finally {
    MonitorDatabase.prototype.repairStoredWorksCoverage = legacyRepair;
  }
});

test("reopening preserves every saved unknown account and topic field without deriving historical success", t => {
  const directory = mkdtempSync(join(tmpdir(), "unknown-coverage-reopen-"));
  const filePath = join(directory, "fixture.sqlite");
  let database = new MonitorDatabase(filePath);
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const author = database.createTarget(account);
  const topic = database.createTarget({ type: "hashtag", provider: "public-web", label: "#测试话题", locator: "测试话题" });
  const insert = database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,hashtag_participants,hashtag_views,
    quality_status,account_status,works_coverage,warnings_json,source_checksum,raw_json)
    VALUES(?,?,?,?,?,?,?,'warning','unknown','unknown',?,'preserve-checksum','{}')`);
  insert.run(author.id,"2026-09-27T02:00:00Z",0,0,0,null,null,'[]');
  insert.run(author.id,"2026-09-27T02:01:00Z",1,2,3,null,null,'["作品列表接口未通过 HTTP 403"]');
  insert.run(topic.id,"2026-09-27T02:00:00Z",null,null,null,0,0,'[]');
  insert.run(topic.id,"2026-09-27T02:01:00Z",null,null,null,null,null,'[]');
  const original = database.db.prepare('SELECT * FROM snapshots ORDER BY id').all();
  for (let i = 0; i < 2; i++) {
    database.close(); database = new MonitorDatabase(filePath);
    assert.deepEqual(database.db.prepare('SELECT * FROM snapshots ORDER BY id').all(), original);
  }
});

test("scheduler saves a fresh available profile during works retry while retaining old posts and metrics", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "publication-coverage-scheduler-"));
  const database = new MonitorDatabase(join(directory, "fixture.sqlite"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget(account);
  const oldRaw = payload("complete", { postCount: 1 });
  oldRaw.capturedAt = "2026-09-12T02:00:00.000Z";
  const priorRun = database.beginRun("manual", target.id, 1);
  database.saveCollection(target, priorRun, await providerFor(oldRaw).provider.collect(target));
  database.finishRun(priorRun, { status: "success", successCount: 1 });
  const oldSnapshot = database.db.prepare("SELECT * FROM snapshots ORDER BY id").all();
  const oldPosts = database.db.prepare("SELECT * FROM posts ORDER BY id").all();
  const oldMetrics = database.db.prepare("SELECT * FROM post_metrics ORDER BY id").all();
  const raw = payload("retry", { warnings: ["作品列表接口未通过：响应缺少作品数组"] });
  raw.profile.user.follower_count = 124;
  raw.profile.user.total_favorited = 457;
  let calls = 0;
  const scheduler = new MonitorScheduler(database, { providerOptions: {
    cooldownMs: 0,
    execFileImpl: (_file, args, _options, callback) => {
      calls += 1;
      assert.equal(args[args.indexOf("--operation") + 1], "account");
      callback(null, JSON.stringify({ ok: true, data: raw }), "");
    },
    fetchImpl: () => { throw new Error("network access is forbidden in coverage contract tests"); },
  } });
  const result = await scheduler.runAll({ triggerType: "manual", targetId: target.id });
  assert.equal(calls, 1);
  assert.equal(result.successCount, 1, "the success is the real profile snapshot, not complete works coverage");
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 1);
  assert.equal(result.details[0].profileUsable, true);
  assert.equal(result.details[0].worksCoverage, "retry");
  assert.equal(result.details[0].reviewState, "retry");
  const snapshots = database.db.prepare("SELECT * FROM snapshots ORDER BY id").all();
  assert.deepEqual(snapshots.slice(0, 1), oldSnapshot);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].followers, 124);
  assert.equal(snapshots[1].total_likes, 457);
  assert.equal(snapshots[1].works_coverage, "retry");
  assert.deepEqual(database.db.prepare("SELECT * FROM posts ORDER BY id").all(), oldPosts);
  assert.deepEqual(database.db.prepare("SELECT * FROM post_metrics ORDER BY id").all(), oldMetrics);
  assert.equal(database.getTarget(target.id).enabled, true);
});
