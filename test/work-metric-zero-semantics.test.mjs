import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { normalizePost } from "../lib/providers/normalize.mjs";
import { buildReport } from "../lib/analytics.mjs";
import { getAccountInsight } from "../lib/product-insights.mjs";
import { renderAccountDetail } from "../public/account-detail.js";
import { describeWorkPlays } from "../lib/work-play-semantics.mjs";
import { reportCsv } from "../lib/report-export.mjs";
import * as consoleModel from "../public/console-model.js";

const SEC_UID = "MS4wLjABAAAAzeroSemanticsFixtureAccount";
const reference = new Date("2026-09-28T12:00:00.000Z");
const post = plays => ({ aweme_id: "12345678901234567", author: { sec_uid: SEC_UID }, statistics: { digg_count: 25, play_count: plays } });

// The real detail projection runs against a minimal read-only query boundary;
// this fixture never opens production data or constructs MonitorDatabase.
function detail(plays, platform = "douyin") {
  const target = { id: 1, type: "account", provider: "public-web", label: "独立零值审查",
    locator: platform === "douyin" ? SEC_UID : "123456", enabled: 1,
    metadata_json: JSON.stringify({ platform }), created_at: "2026-09-01T00:00:00.000Z" };
  const db = { exec(sql) {
    assert.match(sql, /^(?:SAVEPOINT|RELEASE) works_observation_read$/);
  }, prepare(sql) { return { get() {
    if (/sqlite_master.*master_roster_imports/.test(sql)) return undefined;
    assert.match(sql, /sqlite_master.*works_observations/);
    return undefined; // Legacy read-only fixture has no separate works ledger.
  }, all() {
    if (/PRAGMA table_info\(snapshots\)/.test(sql)) return [{ name: 'works_observed_at' }];
    if (/SELECT t\.\*/.test(sql) && /FROM targets t/.test(sql)) return [{ ...target, enabled_asof: 1 }];
    if (/SELECT p\.id,p\.external_id,p\.caption/.test(sql)) return [{ id: 1, external_id: "12345678901234567",
      caption: "来源播放字段测试", url: "https://www.douyin.com/video/12345678901234567",
      published_at: "2026-09-27T01:00:00.000Z", captured_at: "2026-09-28T02:00:00.000Z",
      likes: 25, comments: null, shares: 0, collects: null, plays }];
    return [];
  } }; } };
  return getAccountInsight({ db }, 1, { period: "day", reference, timeZone: "Asia/Shanghai" });
}

test("work metric review: missing play_count stays null while an explicit source zero is preserved", () => {
  for (const value of [undefined, null, ""]) assert.equal(normalizePost(post(value)).plays, null);
  assert.equal(normalizePost(post(0)).plays, 0);
  assert.equal(normalizePost(post(123)).plays, 123);
  assert.equal(normalizePost({ aweme_id: "12345678901234567", author: { sec_uid: SEC_UID }, statistics: {} }).plays, null);
});

test("work metric review: raw source zero is retained as evidence rather than rewritten to an estimate", () => {
  const raw = post(0), before = structuredClone(raw);
  const normalized = normalizePost(raw);
  assert.deepEqual(raw, before);
  assert.equal(normalized.raw.statistics.play_count, 0);
  assert.equal(normalized.plays, 0);
  assert.equal(normalized.likes, 25);
  assert.notEqual(normalized.plays, normalized.likes * 100);
});

test("work metric review: matrix estimated growth does not consume zero, unknown or large work playback fields", () => {
  for (const plays of [0, null, 9_000_000_000]) {
    const report = buildReport({ period: "day", bounds: { start: "2026-09-27T16:00:00.000Z", end: reference.toISOString() },
      posts: [{ id: 1, external_id: "12345678901234567", target_id: 1, author_id: SEC_UID, likes: 25, plays }],
      metrics: [], snapshots: [], targets: [{ id: 1, type: "account", enabled: true, metadata: { platform: "douyin" } }],
      snapshotComparisons: [{ target_id: 1, baseline_total_likes: 100, current_total_likes: 120 }] });
    assert.equal(report.summary.estimatedPlaysDelta, 2000);
    assert.equal(report.contributors[0].estimatedPlaysDelta, 2000);
    assert.equal(report.posts[0].plays, plays);
    assert.equal(Object.hasOwn(report.summary, "playsCurrent"), false);
    assert.equal(Object.hasOwn(report.summary, "actualPlays"), false);
  }
});

test("work metric review: real account detail projection preserves null and explicit zero independently", () => {
  assert.equal(detail(null).recentWorks[0].plays, null);
  assert.equal(detail(0).recentWorks[0].plays, 0);
  assert.match(detail(0).methodology.proxy, /不是平台真实播放量/);
});

test("work metric review: legacy detail keeps Douyin source zero inside a qualified evidence disclosure", () => {
  const html = renderAccountDetail(detail(0));
  assert.match(html, /公开来源返回：0/);
  assert.match(html, /0可能是匿名占位，不能视为真实播放量/);
  assert.match(html, /估算播放<\/dt><dd>2,500/);
  assert.doesNotMatch(html, /<dt>实际播放|<dt>实测播放/);
});

test("work metric review: current rebuilt works block does not expose raw zero as a playback KPI", () => {
  const source = readFileSync(new URL("../public/rebuild.js", import.meta.url), "utf8")
    .replace(/^import[^\n]+\n/, "").replace(/void init\(\);\s*$/, "");
  const context = { ...consoleModel, fmt: consoleModel.formatNumber, URL, Date, Intl, document: { addEventListener() {} },
    location: new URL("https://fixture.invalid/#accounts") };
  runInNewContext(`${source}\nthis.render=renderWorksEvidence;`, context);
  const html = context.render(detail(0), { start: "2026-09-28", end: "2026-09-28" });
  assert.match(html, /作品与发布证据/);
  assert.doesNotMatch(html, /<small>[^<]*播放|<dt>[^<]*播放|实际播放|实测播放/);
});

test("work metric review: source playback semantics distinguish Douyin zero from missing and other platforms", () => {
  for (const value of [undefined, null, false, true, "0", "123", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const evidence = describeWorkPlays(value, "douyin");
    assert.equal(evidence.basis, "missing");
    assert.equal(evidence.actualCountVerified, false);
    assert.equal(evidence.mayBePlaceholder, null);
    assert.match(evidence.note, /缺|未提供|未知/);
  }
  const zero = describeWorkPlays(0, "douyin");
  assert.equal(zero.basis, "source-reported-unverified");
  assert.equal(zero.actualCountVerified, false);
  assert.equal(zero.mayBePlaceholder, true);
  assert.match(zero.note, /0.*占位|占位.*0/);
  for (const [value, platform] of [[123, "douyin"], [0, "bilibili"], [0, "xiaohongshu"], [0, "unknown"]]) {
    const evidence = describeWorkPlays(value, platform);
    assert.equal(evidence.basis, "source-reported-unverified");
    assert.equal(evidence.actualCountVerified, false);
    assert.equal(evidence.mayBePlaceholder, null);
    assert.doesNotMatch(evidence.note, /抖音.*占位|匿名占位/);
  }
});

test("work metric review: real recentWorks API attaches platform-aware evidence without replacing source values", () => {
  for (const platform of ["douyin", "bilibili"]) for (const plays of [null, 0, 123]) {
    const work = detail(plays, platform).recentWorks[0];
    assert.equal(work.plays, plays);
    assert.deepEqual(work.playsEvidence, describeWorkPlays(plays, platform));
    assert.equal(work.likes, 25);
    assert.equal(work.shares, 0);
  }
});

function reportWithWork(plays, platform = "douyin") {
  return buildReport({ period: "day", bounds: { start: "2026-09-27T16:00:00.000Z", end: reference.toISOString() },
    posts: [{ id: 1, external_id: "12345678901234567", target_id: 1, target_label: "测试目标", author_name: "测试作者",
      author_id: SEC_UID, likes: 25_000, plays, comments: null, shares: 0, collects: null,
      published_at: "2026-09-28T01:00:00.000Z", caption: "纯离线标题", url: "https://www.douyin.com/video/12345678901234567" }],
    metrics: [], snapshots: [], targets: [{ id: 1, type: "account", enabled: true, metadata: { platform } }] });
}

test("work metric review: report and viral evidence use target platform without inferring it from author or video ID", () => {
  for (const platform of ["douyin", "bilibili"]) for (const plays of [null, 0, 123]) {
    const report = reportWithWork(plays, platform);
    assert.equal(report.posts[0].plays, plays);
    assert.equal(report.viral.length, 1);
    assert.equal(report.viral[0].plays, plays);
    assert.deepEqual(report.posts[0].playsEvidence, describeWorkPlays(plays, platform));
    assert.deepEqual(report.viral[0].playsEvidence, describeWorkPlays(plays, platform));
    assert.equal(report.summary.estimatedPlaysDelta, null, "no account baseline is still missing; post likes are not substituted");
  }
});

test("work metric review: CSV preserves original numeric positions and appends a platform-aware explanatory column", () => {
  for (const platform of ["douyin", "bilibili"]) for (const plays of [null, 0, 123]) {
    const report = reportWithWork(plays, platform);
    const [headerLine, rowLine] = reportCsv(report).split("\n");
    const header = headerLine.split(","), row = rowLine.split(",");
    assert.equal(header[9], "来源播放字段（非估算）");
    assert.equal(header[12], "播放字段说明");
    assert.equal(header.length, 13);
    assert.equal(row[9], plays === null ? "" : String(plays));
    assert.equal(row[10], "纯离线标题");
    assert.equal(row[11], "https://www.douyin.com/video/12345678901234567");
    assert.ok(rowLine.includes(describeWorkPlays(plays, platform).note));
  }
});

test("historical report CSV exposes period-end board membership and current enabled-state limits", () => {
  const report = reportWithWork(123);
  report.selectedBoard = { name: "团团切片" };
  report.scopeBasis = {
    description: "只纳入区间末前已创建的账号；指标按所选区间内的真实观测；板块归属按区间末已生效关系；停用状态以及作者/板块显示名称按当前记录（尚无完整历史版本）。",
  };
  const [header] = reportCsv(report).split("\n");
  assert.match(header, /报告筛选范围（团团切片）/);
  assert.match(header, /板块归属按区间末已生效关系/);
  assert.match(header, /停用状态以及作者\/板块显示名称按当前记录/);
});
