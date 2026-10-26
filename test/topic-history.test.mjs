import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MonitorDatabase } from "../lib/database.mjs";
import { businessDateKey, checksum } from "../lib/utils.mjs";

function insertSnapshot(database, targetId, capturedAt, participants, views, qualityStatus = "validated") {
  const sampledAt = new Date(capturedAt).toISOString();
  const target = database.getTarget(targetId);
  if (target?.type !== "hashtag" || target.provider !== "public-web") {
    return database.db.prepare(`
      INSERT INTO snapshots(target_id,captured_at,hashtag_participants,hashtag_views,quality_status,
        account_status,works_coverage,warnings_json,source_checksum,raw_json)
      VALUES(?,?,?,?,?,'unknown','not-applicable','[]','unbound-topic-test','{}')
    `).run(targetId, sampledAt, participants, views, qualityStatus);
  }
  const runId = database.beginRun("scheduled", target.id, 1);
  database.db.prepare("UPDATE runs SET started_at=? WHERE id=?").run(new Date(Date.parse(sampledAt) - 60_000).toISOString(), runId);
  const name = target.locator.replace(/^#/, "");
  const raw = {
    scope: "douyin-official-challenge-detail", businessStatusCode: 0,
    challengeId: "7684603502", label: name, officialName: name,
    participants, views, capturedAt: sampledAt,
    provenance: { mode: "douyin-official-anonymous-challenge-detail",
      endpoint: "https://www.douyin.com/aweme/v1/web/challenge/detail/",
      authenticated: false, runtimeAI: false, paidAPI: false },
  };
  const savedQuality = qualityStatus === "validated" && (participants === null || views === null) ? "warning" : qualityStatus;
  const sourceChecksum = checksum(raw);
  database.db.prepare(`
    INSERT INTO snapshots(
      target_id,captured_at,hashtag_participants,hashtag_views,quality_status,
      account_status,works_coverage,warnings_json,source_checksum,raw_json
    ) VALUES(?,?,?,?,?,'unknown','not-applicable','[]',?,?)
  `).run(targetId, sampledAt, participants, views, savedQuality, sourceChecksum, JSON.stringify(raw));
  const auditAt = new Date(Date.parse(sampledAt) + 1000).toISOString();
  database.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,source_checksum,message)
    VALUES(?,?,?,'public-web',?,?,?)`).run(target.id, runId, auditAt, savedQuality, sourceChecksum, "isolated topic fixture");
  database.finishRun(runId, { status: "success", successCount: 1, processedCount: 1 });
}

function topicFixture(t, label = "#基准话题") {
  const directory = mkdtempSync(join(tmpdir(), "topic-history-baseline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => database.close());
  const topic = database.createTarget({ type: "hashtag", label, locator: label, provider: "public-web" });
  return { database, topic };
}

test("topic history keeps calendar gaps null and never bridges deltas across a missing day", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "topic-history-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new MonitorDatabase(join(directory, "test.sqlite"));
  t.after(() => database.close());
  const topic = database.createTarget({ type: "hashtag", label: "#历史话题", locator: "#历史话题", provider: "public-web" });
  const ignoredAccount = database.createTarget({ type: "account", label: "不要混入", locator: "account-history-topic", provider: "manual" });
  // 16:00Z is exactly 00:00 in Beijing. It belongs to the following
  // business day even when this test process runs in Los Angeles/UTC.
  assert.equal(businessDateKey("2026-09-09T15:59:59.999Z"), "2026-09-09");
  assert.equal(businessDateKey("2026-09-09T16:00:00.000Z"), "2026-09-10");
  insertSnapshot(database, topic.id, "2026-09-09T16:00:00.000Z", 90, 900);
  insertSnapshot(database, topic.id, "2026-09-10T10:00:00.000Z", 100, 1000);
  insertSnapshot(database, topic.id, "2026-09-11T10:00:00.000Z", 110, 1250);
  insertSnapshot(database, topic.id, "2026-09-13T10:00:00.000Z", 145, 1800);
  insertSnapshot(database, topic.id, "2026-09-14T10:00:00.000Z", 150, 1900, "rejected");
  insertSnapshot(database, ignoredAccount.id, "2026-09-12T10:00:00.000Z", 999, 9999);

  const history = database.listTopicHistory({ startDate: "2026-09-10", endDate: "2026-09-14" });
  assert.equal(history.days, 5);
  assert.deepEqual(history.topics.map((item) => item.label), ["#历史话题"]);
  const points = history.topics[0].points;
  assert.equal(history.topics[0].observedCount, 3, "only days with official topic metrics count as observed");
  assert.equal(history.topics[0].sampledCount, 4, "a sampled day without official fields remains separately auditable");
  assert.deepEqual(points.map((point) => point.date), ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"]);
  assert.equal(points[1].participantsDelta, 10);
  assert.equal(points[2].participants, null, "missing day remains unknown");
  assert.equal(points[3].participantsDelta, null, "delta does not bridge the missing day");
  assert.equal(points[4].qualityStatus, "rejected");
  assert.equal(points[4].participants, null, "rejected official metrics are not presented as valid values");
  assert.equal(points[4].viewsDelta, null);
});

test("topic history reports participant and play-count coverage independently", (t) => {
  const { database, topic } = topicFixture(t, "#只有参与人数");
  for (let day = 1; day <= 7; day++) {
    const date = `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
    insertSnapshot(database, topic.id, date, 100 + day, null, day === 4 ? "warning" : "validated");
  }
  const result = database.listTopicHistory({ startDate: "2026-09-01", endDate: "2026-09-07" }).topics[0];
  assert.equal(result.observedCount, 7, "legacy any-metric count remains available");
  assert.equal(result.participantsObservedCount, 7);
  assert.equal(result.viewsObservedCount, 0, "a participant value does not imply a play-count observation");
  assert.equal(result.participantsMissingCount, 0);
  assert.equal(result.viewsMissingCount, 7);
  assert.equal(result.points[3].qualityStatus, "warning", "quality warning remains attached to the sampled day");
});

test("single-day topic history reads the previous Beijing day as baseline without returning or counting it", (t) => {
  const { database, topic } = topicFixture(t);
  insertSnapshot(database, topic.id, "2026-09-19T10:00:00.000Z", 100, 1000);
  insertSnapshot(database, topic.id, "2026-09-20T10:00:00.000Z", 110, 1250);
  const before = database.db.prepare("SELECT * FROM snapshots ORDER BY id").all();
  const history = database.listTopicHistory({ startDate: "2026-09-20", endDate: "2026-09-20" });
  const result = history.topics[0], point = result.points[0];
  assert.equal(history.days, 1);
  assert.deepEqual(result.points.map(({ date }) => date), ["2026-09-20"]);
  assert.equal(result.observedCount, 1);
  assert.equal(result.sampledCount, 1);
  assert.equal(point.participantsDelta, 10);
  assert.equal(point.viewsDelta, 250);
  assert.equal(point.capturedAt, "2026-09-20T10:00:00.000Z");
  assert.match(point.sourceChecksum, /^[a-f0-9]{64}$/);
  assert.equal(point.baselineDate, "2026-09-19");
  assert.equal(point.baselineCapturedAt, "2026-09-19T10:00:00.000Z");
  assert.match(point.baselineSourceChecksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(database.db.prepare("SELECT * FROM snapshots ORDER BY id").all(), before, "history reads must not change original snapshots");
});

test("multi-day topic history computes its first day against only the immediately preceding date", (t) => {
  const { database, topic } = topicFixture(t);
  insertSnapshot(database, topic.id, "2026-09-19T10:00:00.000Z", 100, 1000);
  insertSnapshot(database, topic.id, "2026-09-20T10:00:00.000Z", 95, 1100);
  insertSnapshot(database, topic.id, "2026-09-21T10:00:00.000Z", 100, 900);
  const result = database.listTopicHistory({ startDate: "2026-09-20", endDate: "2026-09-21" }).topics[0];
  assert.deepEqual(result.points.map(point => [point.date, point.participantsDelta, point.viewsDelta]), [
    ["2026-09-20", -5, 100], ["2026-09-21", 5, -200],
  ]);
  assert.equal(result.points[1].baselineDate, "2026-09-20");
});

test("missing previous calendar day cannot borrow an older topic snapshot", (t) => {
  const { database, topic } = topicFixture(t);
  insertSnapshot(database, topic.id, "2026-09-18T10:00:00.000Z", 100, 1000);
  insertSnapshot(database, topic.id, "2026-09-20T10:00:00.000Z", 110, 1250);
  const point = database.listTopicHistory({ startDate: "2026-09-20", endDate: "2026-09-20" }).topics[0].points[0];
  assert.equal(point.participantsDelta, null);
  assert.equal(point.viewsDelta, null);
  assert.equal(point.baselineDate, null);
  assert.equal(point.baselineCapturedAt, null);
});

test("rejected latest baseline blocks deltas instead of falling back to earlier valid same-day metrics", (t) => {
  const { database, topic } = topicFixture(t);
  insertSnapshot(database, topic.id, "2026-09-19T10:00:00.000Z", 100, 1000);
  insertSnapshot(database, topic.id, "2026-09-19T11:00:00.000Z", 105, 1100, "rejected");
  insertSnapshot(database, topic.id, "2026-09-20T10:00:00.000Z", 110, 1250);
  const point = database.listTopicHistory({ startDate: "2026-09-20", endDate: "2026-09-20" }).topics[0].points[0];
  assert.equal(point.participantsDelta, null);
  assert.equal(point.viewsDelta, null);
  assert.equal(point.baselineCapturedAt, "2026-09-19T11:00:00.000Z");
  assert.equal(point.baselineQualityStatus, "rejected");
});

test("topic baseline metrics are independent and preserve an actual zero", (t) => {
  const { database, topic } = topicFixture(t, "#缺参与人数");
  const other = database.createTarget({ type: "hashtag", label: "#缺播放量", locator: "#缺播放量", provider: "public-web" });
  insertSnapshot(database, topic.id, "2026-09-19T10:00:00.000Z", null, 0);
  insertSnapshot(database, topic.id, "2026-09-20T10:00:00.000Z", 12, 5);
  insertSnapshot(database, other.id, "2026-09-19T10:00:00.000Z", 0, null);
  insertSnapshot(database, other.id, "2026-09-20T10:00:00.000Z", 0, 10);
  const results = database.listTopicHistory({ startDate: "2026-09-20", endDate: "2026-09-20" }).topics;
  const missingParticipants = results.find(result => result.id === topic.id).points[0];
  const missingViews = results.find(result => result.id === other.id).points[0];
  assert.equal(results.find(result => result.id === topic.id).participantsObservedCount, 1);
  assert.equal(results.find(result => result.id === topic.id).viewsObservedCount, 1);
  assert.equal(results.find(result => result.id === other.id).participantsObservedCount, 1, "a measured zero counts as an observation");
  assert.equal(results.find(result => result.id === other.id).viewsObservedCount, 1);
  assert.equal(missingParticipants.participantsDelta, null);
  assert.equal(missingParticipants.viewsDelta, 5);
  assert.equal(missingViews.participantsDelta, 0);
  assert.equal(missingViews.viewsDelta, null);
});

test("baseline uses Beijing midnight at UTC 16 and retains negative changes down to zero", (t) => {
  const { database, topic } = topicFixture(t);
  insertSnapshot(database, topic.id, "2026-09-18T15:59:59.999Z", 999, 9999);
  insertSnapshot(database, topic.id, "2026-09-19T15:59:59.999Z", 10, 20);
  insertSnapshot(database, topic.id, "2026-09-19T16:00:00.000Z", 0, 0);
  const result = database.listTopicHistory({ startDate: "2026-09-20", endDate: "2026-09-20" }).topics[0];
  assert.equal(result.points.length, 1);
  assert.equal(result.observedCount, 1);
  assert.equal(result.participantsObservedCount, 1, "an actual zero counts as observed");
  assert.equal(result.viewsObservedCount, 1, "an actual zero counts as observed");
  assert.equal(result.points[0].participants, 0);
  assert.equal(result.points[0].views, 0);
  assert.equal(result.points[0].participantsDelta, -10);
  assert.equal(result.points[0].viewsDelta, -20);
  assert.equal(result.points[0].baselineDate, "2026-09-19");
  assert.equal(result.points[0].baselineCapturedAt, "2026-09-19T15:59:59.999Z");
});

test("a baseline alone cannot become an in-range observation or invent current values", (t) => {
  const { database, topic } = topicFixture(t);
  insertSnapshot(database, topic.id, "2026-09-19T10:00:00.000Z", 100, 1000);
  const result = database.listTopicHistory({ startDate: "2026-09-20", endDate: "2026-09-20" }).topics[0];
  assert.equal(result.observedCount, 0);
  assert.equal(result.sampledCount, 0);
  assert.equal(result.missingCount, 1);
  assert.equal(result.latestAt, null);
  assert.equal(result.points[0].qualityStatus, "missing");
  assert.equal(result.points[0].participants, null);
  assert.equal(result.points[0].views, null);
  assert.equal(result.points[0].participantsDelta, null);
  assert.equal(result.points[0].viewsDelta, null);
});

test("current-day missing fields also remain independent from the complete baseline", (t) => {
  const { database, topic } = topicFixture(t);
  insertSnapshot(database, topic.id, "2026-09-19T10:00:00.000Z", 100, 1000);
  insertSnapshot(database, topic.id, "2026-09-20T10:00:00.000Z", null, 990);
  const point = database.listTopicHistory({ startDate: "2026-09-20", endDate: "2026-09-20" }).topics[0].points[0];
  assert.equal(point.participantsDelta, null);
  assert.equal(point.viewsDelta, -10);
});
